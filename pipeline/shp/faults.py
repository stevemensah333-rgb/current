"""Spots slow drift in a device before it fails.

Every usable switch-on of a known device is compared with that device's fixed baseline and logged.
Each day the rows are averaged. An alert is raised when a daily average sits outside the baseline
range for 3 days in a row. Alerts use shape, surge peak and settle time only: size and step follow
the grid voltage (about +/-10 %), so they are logged but raise no alerts until a voltage sensor exists.
"""
import json
import statistics
from dataclasses import asdict, dataclass, field
from pathlib import Path

from shp.classifier import UNKNOWN, Prediction
from shp.extractor import Signature, shape_distance
from shp.library import Library, surge_peak
from shp.settings import Settings

ALERT_VALUES = ("shape_diff", "surge_peak", "settle_ms")


@dataclass(frozen=True)
class Row:
    day: int
    label: str                  # the device, or its nearest device when the result was unknown
    unknown: bool
    shape_diff: float
    surge_peak: float
    settle_ms: float
    size_a: float
    step_va: float
    p: float


@dataclass(frozen=True)
class Alert:
    day: int
    label: str
    value: str
    daily_mean: float


@dataclass
class FaultMonitor:
    settings: Settings
    rows: list[Row] = field(default_factory=list)
    raised: set = field(default_factory=set)

    def log(self, sig: Signature, pred: Prediction, library: Library, day: int) -> Row | None:
        """day: a calendar day number from the caller's wall clock."""
        if (sig.direction < 0 or not (sig.clean and sig.settled and sig.shape_ok) or sig.low_trust):
            return None
        unknown = pred.label == UNKNOWN
        label = pred.nearest if unknown else pred.label
        if label is None or (not unknown and not pred.power_match):
            return None
        dev = library.get(label)
        if dev is None:
            return None
        b = dev.baseline
        row = Row(day, label, unknown, shape_distance(sig.steady, b.shape), surge_peak(sig),
                  sig.settle_ms, sig.size_a, abs(sig.step_va), pred.p)
        self.rows.append(row)
        return row

    def save(self, path: str | Path) -> None:
        """Rows and raised alerts survive restarts, so a 3-day streak is not lost."""
        Path(path).write_text(json.dumps({"rows": [asdict(r) for r in self.rows],
                                          "raised": [list(k) for k in sorted(self.raised, key=str)]}))

    @classmethod
    def load(cls, settings: Settings, path: str | Path) -> "FaultMonitor":
        p = Path(path)
        if not p.exists():
            return cls(settings)
        d = json.loads(p.read_text())
        return cls(settings, [Row(**r) for r in d["rows"]], {tuple(k) for k in d["raised"]})

    def health(self, label: str, library: Library) -> dict | None:
        """One device's health on its latest day with data: each alert value against its normal range.
        status: "ok" (all in range), "watch" (out of range, fewer than fault_days days in a row),
        "alert" (out of range fault_days days in a row). None if the device has no rows yet."""
        dev = library.get(label)
        rows = [r for r in self.rows if r.label == label and not r.unknown]
        if dev is None or not rows:
            return None
        b, day = dev.baseline, max(r.day for r in rows)

        def outside(day_rows) -> bool:
            mean = lambda v: statistics.fmean(getattr(r, v) for r in day_rows)   # noqa: E731
            return (mean("shape_diff") > b.shape_limit or not b.surge_peak.holds(mean("surge_peak"))
                    or not b.settle_ms.holds(mean("settle_ms")))
        streak, d = 0, day
        while True:                                    # calendar days in a row, counting back from today
            day_rows = [r for r in rows if r.day == d]
            if not day_rows or not outside(day_rows):
                break
            streak, d = streak + 1, d - 1
        today = [r for r in rows if r.day == day]
        mean = lambda v: statistics.fmean(getattr(r, v) for r in today)   # noqa: E731
        return {"label": label, "day": day, "samples": len(today), "days_outside": streak,
                "status": "alert" if streak >= self.settings.fault_days else "watch" if streak else "ok",
                "shape_diff": mean("shape_diff"), "shape_limit": b.shape_limit,
                "surge_peak": mean("surge_peak"), "surge_low": b.surge_peak.low, "surge_high": b.surge_peak.high,
                "settle_ms": mean("settle_ms"), "settle_low": b.settle_ms.low, "settle_high": b.settle_ms.high,
                "p": mean("p")}

    def check(self, library: Library) -> list[Alert]:
        """New alerts for values outside the baseline range for fault_days days in a row."""
        new = []
        n = self.settings.fault_days
        for dev in library.devices:
            b = dev.baseline
            days = sorted({r.day for r in self.rows if r.label == dev.label and not r.unknown})
            for value in ALERT_VALUES:
                means = {d: statistics.fmean(getattr(r, value) for r in self.rows
                                              if r.label == dev.label and r.day == d and not r.unknown)
                         for d in days}
                streak, start, prev = 0, None, None
                for d in days:
                    out = (means[d] > b.shape_limit if value == "shape_diff"
                           else not getattr(b, value).holds(means[d]))
                    if not out or prev is None or d != prev + 1:   # calendar days in a row
                        streak, start = 0, None
                    if out:
                        streak, start = streak + 1, start if start is not None else d
                    prev = d
                    key = (dev.label, value, start)   # one alert per streak
                    if streak >= n and key not in self.raised:
                        self.raised.add(key)
                        new.append(Alert(d, dev.label, value, means[d]))
        return new
