"""Finds switch-on and switch-off steps in the Cycle stream.

Three states, one cycle at a time:
  WATCH    keep the last 10 steady cycles as 'before'; a cycle far from their average starts CAPTURE
  CAPTURE  collect 'after' cycles until the device settles
  DECIDE   step = settled level - before level; a small step is a blip, a big one becomes an Event

Gaps: in WATCH the old before level is kept and compared with the first 10 cycles after the gap,
so a switch hidden in a gap is still reported. Any event that touches a gap has clean = False.
"""
import statistics
from collections import deque
from dataclasses import dataclass
from typing import Iterable, Iterator

from shp.settings import MAINS_V
from shp.transform import Cycle

STEADY_CYCLES = 10      # our steady shape is 10 averaged cycles
SURGE_CYCLES = 50       # our surge shape covers ~1 s
MAX_AFTER_CYCLES = 500  # 10 s; a device that never settles cannot block detection
NOISE_MULT = 5          # normal noise almost never reaches 5x its own spread


@dataclass(frozen=True)
class Event:
    direction: int               # +1 on, -1 off
    t_ms: int                    # first changed cycle
    step_a: float                # settled level - before level; negative for off
    before: tuple[Cycle, ...]    # 10 steady cycles before the step
    after: tuple[Cycle, ...]     # surge to settled
    settled: bool                # False if MAX_AFTER_CYCLES was hit
    clean: bool                  # False if a gap touched the event; do not learn from it

    @property
    def step_va(self) -> float:
        """Apparent power of the step: 230 V x amps. True watts need a voltage sensor."""
        return MAINS_V * self.step_a


def calibrate(quiet_cycles: Iterable[Cycle]) -> float:
    """threshold_a from a recording with nothing switching."""
    levels = [c.current_a for c in quiet_cycles]
    if len(levels) < 2:
        raise ValueError("need at least 2 quiet cycles")
    return NOISE_MULT * statistics.pstdev(levels)


def _level(cycles) -> float:
    return statistics.fmean(c.current_a for c in cycles)


class Detector:
    def __init__(self, threshold_a: float):
        self.threshold = threshold_a
        self.before = deque(maxlen=STEADY_CYCLES)
        self.held_before = None   # (level, before cycles) kept across a gap in WATCH
        self.after = None         # list while in CAPTURE
        self.before_level = 0.0
        self.before_cycles = ()
        self.rising = True
        self.clean = True

    def feed(self, c: Cycle) -> Event | None:
        if self.after is not None:
            return self._capture(c)
        return self._watch(c)

    def _watch(self, c: Cycle) -> Event | None:
        if c.gap_before:
            if self.held_before is None and len(self.before) == STEADY_CYCLES:
                self.held_before = (_level(self.before), tuple(self.before))
            self.before.clear()

        if self.held_before is not None:  # refilling after a gap
            self.before.append(c)
            if len(self.before) < STEADY_CYCLES:
                return None
            old_level, old_before = self.held_before
            self.held_before = None
            step = _level(self.before) - old_level
            if abs(step) <= self.threshold:
                return None
            # The first cycles after a gap may be mid-surge, so the level is not known to be settled.
            return Event(1 if step > 0 else -1, self.before[0].t_ms, step, old_before,
                         tuple(self.before), settled=False, clean=False)

        if len(self.before) < STEADY_CYCLES:
            self.before.append(c)
            return None
        base = _level(self.before)
        if abs(c.current_a - base) <= self.threshold:
            self.before.append(c)
            return None
        self.before_level, self.before_cycles = base, tuple(self.before)
        self.rising = c.current_a > base
        self.after, self.clean = [c], True
        return None

    def _capture(self, c: Cycle) -> Event | None:
        if c.gap_before:
            self.clean = False
        self.after.append(c)
        n = len(self.after)
        if n < (SURGE_CYCLES if self.rising else 2 * STEADY_CYCLES):
            return None
        last = self.after[-STEADY_CYCLES:]
        prev = self.after[-2 * STEADY_CYCLES:-STEADY_CYCLES]
        settled = abs(_level(last) - _level(prev)) < self.threshold
        if not settled and n < MAX_AFTER_CYCLES:
            return None
        return self._decide(settled)

    def _decide(self, settled: bool) -> Event | None:
        after = tuple(self.after)
        self.after = None
        self.before = deque(after[-STEADY_CYCLES:], maxlen=STEADY_CYCLES)
        step = _level(after[-STEADY_CYCLES:]) - self.before_level
        if abs(step) <= self.threshold:
            return None  # blip: the current went back to where it was
        return Event(1 if step > 0 else -1, after[0].t_ms, step, self.before_cycles, after,
                     settled, self.clean)


def detect(cycles: Iterable[Cycle], threshold_a: float) -> Iterator[Event]:
    d = Detector(threshold_a)
    for c in cycles:
        e = d.feed(c)
        if e is not None:
            yield e
