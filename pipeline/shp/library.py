"""Teach mode and the device library.

A TeachSession collects 3-5 good switch-on and switch-off rounds for one device and drops odd rounds.
finish() gives a DeviceEntry: the rounds (examples for the classifier) and a fixed baseline (fault monitor).
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
    room: str = "Living room"     # one of ROOMS

    @property
    def label(self) -> str:
        return f"{self.name}|{self.setting}" if self.setting else self.name


ROOMS = ("Living room", "Kitchen", "Bedroom", "Office")   # the rooms the app's house has


def base_name(label: str) -> str:
    """'mixer|speed 3' -> 'mixer'. Usage and the SLM use the merged name."""
    return label.split("|")[0]


class TeachSession:
    """add() each signature while the user switches the device on and off."""

    def __init__(self, name: str, settings: Settings, setting: str | None = None,
                 kind: str = "generic", room: str = "Living room"):
        if room not in ROOMS:
            raise ValueError(f"room must be one of: {', '.join(ROOMS)}")
        self.name, self.setting, self.settings = name, setting, settings
        self.kind, self.room = kind, room
        self.on: list[Signature] = []
        self.off: list[Signature] = []
        self.rounds = 0   # switch-on attempts; a round is one on + off

    def add(self, sig: Signature) -> str:
        if sig.direction > 0:
            self.rounds += 1
        if not sig.clean:
            msg = "refused: readings were lost, do one more round"
        elif not sig.settled:
            msg = "refused: the device never settled, do one more round"
        elif not sig.shape_ok:
            msg = "refused: no shape, do one more round"
        elif sig.low_trust:
            msg = "refused: other big loads are on; switch them off and do one more round"
        else:
            group = self.on if sig.direction > 0 else self.off
            group.append(sig)
            odd = self._drop_odd(group)
            msg = f"odd round dropped ({odd}), do one more round" if odd else "kept"
        if self.ready:
            return msg + "; enough rounds, you can finish"
        if self.rounds >= self.settings.max_rounds:
            return msg + "; this device varies a lot, stopping"
        return msg

    def _drop_odd(self, group: list[Signature]) -> int:
        """Odd = further from the middle than 3 x MAD, never less than a floor. Checked from 3 rounds."""
        if len(group) < 3:
            return 0
        steps = [abs(s.step_va) for s in group]
        mid_step = statistics.median(steps)
        step_lim = max(3 * mad(steps), MAINS_V * self.settings.threshold_a)
        # The median shape here, so one odd round cannot drag the middle; finish() uses the mean of good rounds.
        mid_shape = np.median([s.steady for s in group], axis=0)
        dists = [shape_distance(s.steady, mid_shape) for s in group]
        shape_lim = max(3 * mad(dists), self.settings.shape_floor)
        keep = [s for s, st, d in zip(group, steps, dists)
                if abs(st - mid_step) <= step_lim and d <= shape_lim]
        dropped = len(group) - len(keep)
        group[:] = keep
        return dropped

    @property
    def ready(self) -> bool:
        return len(self.on) >= self.settings.min_rounds and len(self.off) >= self.settings.min_rounds

    @property
    def varies(self) -> bool:
        return not self.ready and self.rounds >= self.settings.max_rounds

    def finish(self) -> DeviceEntry:
        if not self.ready:
            raise ValueError(f"need {self.settings.min_rounds} good on- and off-rounds, "
                             f"have {len(self.on)} on and {len(self.off)} off")
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
