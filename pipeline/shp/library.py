"""Teach mode and the device library.

A TeachSession (registration) collects exactly 5 turns for one device: one switch-on plus its switch-off each.
An odd turn is redone; kept turns stay. Each turn keeps its raw waveform.
finish() gives a DeviceEntry: the turns (examples for the classifier) and a fixed baseline (fault monitor).
The Library holds every DeviceEntry plus the working examples, and saves to library.json.
"""
import json
import statistics
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from shp.extractor import Signature, shape_distance
from shp.settings import MAINS_V, Settings


def mad(values) -> float:
    """Median absolute deviation: how far values typically sit from their middle value.
    2000, 2010, 2500 -> middle 2010 -> distances 10, 0, 490 -> MAD 10."""
    m = statistics.median(values)
    return statistics.median(abs(v - m) for v in values)


def surge_peak(sig: Signature) -> float:
    return max(sig.surge) if sig.surge else 0.0


@dataclass
class Range:
    mean: float
    low: float
    high: float

    def holds(self, v: float) -> bool:
        return self.low <= v <= self.high


def make_range(values, floor: float) -> Range:
    mean = statistics.fmean(values)
    half = max(3 * statistics.pstdev(values), floor)
    return Range(mean, mean - half, mean + half)


@dataclass
class Baseline:
    shape: list[float]
    surge: list[float]
    step_va: Range
    size_a: Range
    surge_peak: Range
    settle_ms: Range
    shape_limit: float      # max(3 x MAD of shape distances, shape floor)


@dataclass
class DeviceEntry:
    name: str
    setting: str | None
    on_examples: list[Signature]
    off_examples: list[Signature]
    baseline: Baseline
    live_examples: list[Signature] = field(default_factory=list)
    kind: str = "generic"         # how the app's house draws it, e.g. "fridge", "lights", "ac"
    room: str = "Living room"     # a room name from the home the user built in the app

    @property
    def label(self) -> str:
        return f"{self.name}|{self.setting}" if self.setting else self.name


ROOM_MAX = 16   # the app limits room names to 16 characters


def base_name(label: str) -> str:
    """'mixer|speed 3' -> 'mixer'. Usage and the SLM use the merged name."""
    return label.split("|")[0]


@dataclass
class Turn:
    """What one switch did during registration. A kept turn is one switch-on plus its matching switch-off.

    status: "kept"     the turn counts (number 1 to 5)
            "waiting"  a good switch-on; now switch the device off
            "redo"     the switch-on and switch-off did not make a good turn; do it again
            "refused"  this switch could not be used (lost readings, never settled, other loads...)
            "ignored"  a switch-off with no switch-on before it, or a switch after the last turn
    waveform: the raw clamp readings of both switches, for a kept or redo turn.
    """
    status: str
    message: str
    number: int | None = None
    on: Signature | None = None
    off: Signature | None = None
    waveform: dict | None = None


def _cycles(cycles) -> list[list[float]]:
    return [[round(r, 4) for r in c.readings] for c in cycles]


def raw_waveform(on_event, off_event) -> dict | None:
    """The raw readings of one turn: 10 cycles before and every cycle after each switch, as the board sent them.
    Example: a kettle that settles in 60 cycles gives on = 10 + 60 cycles and off = 10 + 50 cycles."""
    if on_event is None or off_event is None:
        return None
    first = (on_event.before or on_event.after)[0]

    def part(e):
        return {"t_ms": e.t_ms, "before": _cycles(e.before), "after": _cycles(e.after)}
    return {"readings_per_cycle": len(first.readings), "on": part(on_event), "off": part(off_event)}


def _refusal(sig: Signature) -> str | None:
    if not sig.clean:
        return "readings were lost"
    if not sig.settled:
        return "the device never settled"
    if not sig.shape_ok:
        return "no shape could be read"
    if sig.low_trust:
        return "other big loads are on; switch them off"
    return None


class TeachSession:
    """Registration: exactly settings.teach_turns (5) turns. add() each signature while the user switches the
    device on, waits for it to settle, then switches it off.

    A turn is kept only when its switch-on and switch-off are both usable, the switch-off removes about what the
    switch-on added, and both look like the turns already kept. A turn that does not is a redo: the turns
    already kept stay. Refused switches do not count. After settings.max_redos redos the device varies a lot."""

    def __init__(self, name: str, settings: Settings, setting: str | None = None,
                 kind: str = "generic", room: str = "Living room"):
        room = room.strip()
        if not room or len(room) > ROOM_MAX:
            raise ValueError(f"room must be 1 to {ROOM_MAX} characters, as named in the app")
        self.name, self.setting, self.settings = name, setting, settings
        self.kind, self.room = kind, room
        self.turns: list[Turn] = []          # kept turns only
        self.pending = None                  # (switch-on signature, its event) waiting for its switch-off
        self.redos = 0

    @property
    def target(self) -> int:
        return self.settings.teach_turns

    @property
    def on(self) -> list[Signature]:
        return [t.on for t in self.turns]

    @property
    def off(self) -> list[Signature]:
        return [t.off for t in self.turns]

    @property
    def ready(self) -> bool:
        return len(self.turns) >= self.target

    @property
    def varies(self) -> bool:
        return not self.ready and self.redos >= self.settings.max_redos

    def add(self, sig: Signature, event=None) -> Turn:
        n = len(self.turns) + 1
        if self.ready:
            return Turn("ignored", f"all {self.target} turns are done")
        why = _refusal(sig)
        if sig.direction > 0:
            if why:
                return Turn("refused", f"switch-on refused: {why}. Switch it off, then do turn {n} again.", n)
            replaced = self.pending is not None
            self.pending = (sig, event)
            note = " The switch-on before it had no switch-off, so it was replaced." if replaced else ""
            return Turn("waiting", f"turn {n}: switched on ({sig.step_va:+.0f} VA). Now switch it off.{note}", n, sig)
        if self.pending is None:
            return Turn("ignored", f"a switch-off with no switch-on before it. Switch the device on to start turn {n}.")
        on, on_event = self.pending
        self.pending = None
        wave = raw_waveform(on_event, event)
        problem = f"switch-off refused: {why}" if why else (self._mismatch(on, sig) or self._odd(on, sig))
        if problem:
            self.redos += 1
            msg = f"turn {n} redo: {problem}. Do turn {n} again."
            if self.varies:
                msg += " This device varies a lot; stopping."
            return Turn("redo", msg, n, on, sig, wave)
        turn = Turn("kept", f"turn {n} of {self.target} kept ({on.step_va:+.0f} VA on, {sig.step_va:+.0f} VA off)",
                    n, on, sig, wave)
        self.turns.append(turn)
        if self.ready:
            turn.message += f"; all {self.target} turns done"
        return turn

    def _step_limit(self, steps) -> float:
        floor = MAINS_V * self.settings.threshold_a
        return max(3 * mad(steps), floor) if len(steps) > 1 else floor

    def _mismatch(self, on: Signature, off: Signature) -> str | None:
        """The switch-off should remove what the switch-on added. Example: on +2000 VA, off -1700 VA -> redo."""
        a, b = abs(on.step_va), abs(off.step_va)
        limit = max(self.settings.power_tolerance_frac * a, MAINS_V * self.settings.threshold_a)
        if abs(a - b) > limit:
            return (f"the switch-off ({b:.0f} VA) did not match the switch-on ({a:.0f} VA); "
                    "something else may have changed")
        return None

    def _odd(self, on: Signature, off: Signature) -> str | None:
        """Compared with the kept turns: power step within 3 x MAD of their middle (never less than the noise
        floor), and shape within 3 x MAD of their middle shape (never less than shape_floor)."""
        if not self.turns:
            return None
        for word, new, kept in (("switch-on", on, self.on), ("switch-off", off, self.off)):
            steps = [abs(s.step_va) for s in kept]
            mid_step = statistics.median(steps)
            if abs(abs(new.step_va) - mid_step) > self._step_limit(steps):
                return f"the {word} power ({abs(new.step_va):.0f} VA) is far from the other turns (about {mid_step:.0f} VA)"
            mid = np.median([s.steady for s in kept], axis=0)
            spread = [shape_distance(s.steady, mid) for s in kept]
            limit = max(3 * mad(spread), self.settings.shape_floor) if len(kept) > 1 else self.settings.shape_floor
            if shape_distance(new.steady, mid) > limit:
                return f"the {word} shape is different from the other turns"
        return None

    def finish(self) -> DeviceEntry:
        if not self.ready:
            raise ValueError(f"need {self.target} kept turns, have {len(self.turns)}")
        on = self.on
        shape = np.mean([s.steady for s in on], axis=0)
        surge = np.mean([s.surge for s in on], axis=0)
        dists = [shape_distance(s.steady, shape) for s in on]
        steps = [abs(s.step_va) for s in on]
        sizes = [s.size_a for s in on]
        peaks = [surge_peak(s) for s in on]
        baseline = Baseline(
            shape=[float(v) for v in shape], surge=[float(v) for v in surge],
            step_va=make_range(steps, 0.1 * statistics.fmean(steps)),
            size_a=make_range(sizes, 0.1 * statistics.fmean(sizes)),
            surge_peak=make_range(peaks, 0.1 * statistics.fmean(peaks)),
            settle_ms=make_range([s.settle_ms for s in on], 20),
            shape_limit=max(3 * mad(dists), self.settings.shape_floor))
        return DeviceEntry(self.name, self.setting, list(on), list(self.off), baseline,
                           kind=self.kind, room=self.room)


class Library:
    def __init__(self, devices: list[DeviceEntry] | None = None):
        self.devices = devices or []

    def get(self, label: str) -> DeviceEntry | None:
        return next((d for d in self.devices if d.label == label), None)

    def add_device(self, entry: DeviceEntry) -> None:
        """Teaching the same device again replaces it."""
        self.devices = [d for d in self.devices if d.label != entry.label] + [entry]

    def add_live(self, sig: Signature, pred, settings: Settings) -> bool:
        """A confident live switch-on joins the working examples; newest N per device are kept."""
        dev = self.get(pred.label)
        if (dev is None or sig.direction < 0 or not (sig.clean and sig.settled and sig.shape_ok)
                or sig.low_trust or not pred.power_match or pred.p < settings.working_min_p):
            return False
        dev.live_examples = (dev.live_examples + [sig])[-settings.working_per_device:]
        return True

    def working_on(self, dev: DeviceEntry) -> list[Signature]:
        return dev.on_examples + dev.live_examples

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps([asdict(d) for d in self.devices], indent=1))

    @classmethod
    def load(cls, path: str | Path) -> "Library":
        p = Path(path)
        if not p.exists():
            return cls()
        return cls([_device_from_dict(d) for d in json.loads(p.read_text())])


def _sig(d: dict) -> Signature:
    return Signature(**{**d, "steady": tuple(d["steady"]), "surge": tuple(d["surge"])})


def _device_from_dict(d: dict) -> DeviceEntry:
    b = d["baseline"]
    baseline = Baseline(b["shape"], b["surge"], *(Range(**b[k]) for k in
                        ("step_va", "size_a", "surge_peak", "settle_ms")), b["shape_limit"])
    return DeviceEntry(d["name"], d["setting"], [_sig(s) for s in d["on_examples"]],
                       [_sig(s) for s in d["off_examples"]], baseline,
                       [_sig(s) for s in d["live_examples"]],
                       d.get("kind", "generic"), d.get("room", "Living room"))
