"""Once a second: apparent power (VA), energy, and a check that nothing switched unseen.

The board measures current only, so 230 V x current is apparent power in VA, not true watts.
After every event the monitor re-anchors at the event's settled level. If the power then stays away
from the anchor for 5 s:
  most of the change came within 2 s -> a step nobody saw: flag "missed event", re-anchor
  it crept there slowly             -> the grid: re-anchor quietly
"""
from collections import deque
from dataclasses import dataclass

from shp.settings import MAINS_V, NOMINAL_CYCLES_PER_READING, Settings
from shp.transform import READINGS_PER_CYCLE, Cycle

CYCLES_PER_S = 50


@dataclass(frozen=True)
class Reading:
    t_ms: int
    va: float
    energy_vah: float


@dataclass(frozen=True)
class Flag:
    t_ms: int
    kind: str          # "missed event" or "grid drift"
    delta_va: float


class PowerMonitor:
    def __init__(self, settings: Settings):
        self.s = settings
        self.cycles: list[Cycle] = []
        self.last_end_ms: int | None = None
        self.energy_vah = 0.0
        self.anchor: float | None = None
        self.history: deque[float] = deque(maxlen=settings.drift_hold_s + settings.step_within_s + 1)
        self.away_s = 0
        self.skip_check = False   # the second after a re-anchor may mix old and new levels

    def tolerance(self) -> float:
        return max(2 * MAINS_V * self.s.threshold_a, self.s.drift_frac * (self.anchor or 0.0))

    def reanchor(self, va: float) -> None:
        """Call after every event with the event's settled level (230 x amps). The second in progress
        may still hold cycles from before the step, so it is dropped from the drift check."""
        self.anchor, self.away_s = va, 0
        self.history.clear()
        self.history.append(va)
        self.skip_check = True

    def feed(self, c: Cycle) -> tuple[Reading | None, Flag | None]:
        self.cycles.append(c)
        if len(self.cycles) < CYCLES_PER_S:
            return None, None
        va = MAINS_V * sum(x.current_a for x in self.cycles) / len(self.cycles)
        self.energy_vah += va * self._elapsed_s(c) / 3600
        self.cycles.clear()
        reading = Reading(c.t_ms, va, self.energy_vah)
        if self.anchor is None:
            self.reanchor(va)
        if self.skip_check:
            self.skip_check = False
            return reading, None
        self.history.append(va)
        return reading, self._check(c.t_ms, va)

    def _elapsed_s(self, c: Cycle) -> float:
        """Board time covered by this second's cycles. The first second is estimated from the reading count:
        50 lines x 17 readings x 50/860 cycles per reading / 50 Hz = 0.988 s."""
        if self.last_end_ms is None or c.t_ms <= self.last_end_ms:
            dt = len(self.cycles) * READINGS_PER_CYCLE * NOMINAL_CYCLES_PER_READING / 50
        else:
            dt = (c.t_ms - self.last_end_ms) / 1000
        self.last_end_ms = c.t_ms
        return dt

    def _check(self, t_ms: int, va: float) -> Flag | None:
        if abs(va - self.anchor) <= self.tolerance():
            self.away_s = 0
            return None
        self.away_s += 1
        if self.away_s < self.s.drift_hold_s:
            return None
        h = list(self.history)
        total = va - self.anchor
        w = self.s.step_within_s
        biggest = max((abs(h[i] - h[i - w]) for i in range(w, len(h))), default=0.0)
        kind = "missed event" if biggest >= 0.5 * abs(total) else "grid drift"
        self.reanchor(va)
        self.skip_check = False
        return Flag(t_ms, kind, total)
