"""The on-list: which devices are on now, since when, with what confidence.

It is a list of entries, not a set of names, so two identical lamps can both be on.
Every change is logged; usage and energy per device come from that log.
"""
from dataclasses import dataclass, field
from typing import Callable

from shp.classifier import UNKNOWN, Prediction
from shp.extractor import Signature
from shp.library import base_name


@dataclass
class OnEntry:
    label: str
    p: float
    since_ms: int
    step_va: float
    signature: Signature        # its own switch-on signal, so an unknown entry can still be matched


@dataclass(frozen=True)
class Change:
    t_ms: int
    label: str
    on: bool
    p: float
    step_va: float


@dataclass
class House:
    on_list: list[OnEntry] = field(default_factory=list)
    log: list[Change] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    to_wall: Callable[[int], int] = lambda t_ms: t_ms   # board time -> wall-clock ms; set by the app

    def switched_on(self, sig: Signature, pred: Prediction) -> OnEntry:
        e = OnEntry(pred.label, pred.p, self.to_wall(sig.t_ms), abs(sig.step_va), sig)
        self.on_list.append(e)
        self.log.append(Change(e.since_ms, e.label, True, e.p, e.step_va))
        return e

    def switched_off(self, sig: Signature, pred: Prediction) -> OnEntry | None:
        """Removes the matching entry whose step is closest. Returns None if nothing matched;
        the caller then asks the power monitor to re-anchor."""
        same = [e for e in self.on_list if e.label == pred.label] if pred.matched else []
        if not same:
            self.notes.append(f"{self.to_wall(sig.t_ms)}: unexplained switch-off of {abs(sig.step_va):.0f} VA")
            return None
        e = min(same, key=lambda x: abs(x.step_va - abs(sig.step_va)))
        self.on_list.remove(e)
        self.log.append(Change(self.to_wall(sig.t_ms), e.label, False, pred.p, e.step_va))
        return e

    def summary(self) -> str:
        """The SLM state line, e.g. 'kettle ON 0.94, fridge ON 0.88, unknown ON'."""
        if not self.on_list:
            return "nothing on"
        parts = [f"{e.label} ON" if e.label == UNKNOWN else f"{e.label} ON {e.p:.2f}" for e in self.on_list]
        return ", ".join(parts)

    def usage(self, name: str, start_ms: int, end_ms: int) -> tuple[float, float]:
        """(hours on, VA-hours) for a device by merged name, between start_ms and end_ms."""
        hours = vah = 0.0
        open_on: list[Change] = []
        for c in self.log:
            if base_name(c.label) != name:
                continue
            if c.on:
                open_on.append(c)
            elif open_on:
                on = min(open_on, key=lambda o: abs(o.step_va - c.step_va))
                open_on.remove(on)
                h = _overlap_h(on.t_ms, c.t_ms, start_ms, end_ms)
                hours, vah = hours + h, vah + h * on.step_va
        for on in open_on:  # still on
            h = _overlap_h(on.t_ms, end_ms, start_ms, end_ms)
            hours, vah = hours + h, vah + h * on.step_va
        return hours, vah


def _overlap_h(a: int, b: int, start: int, end: int) -> float:
    return max(0, min(b, end) - max(a, start)) / 3_600_000
