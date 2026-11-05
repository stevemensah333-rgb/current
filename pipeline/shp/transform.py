"""Turns the board's serial text into clean, checked cycles.

The board sends one line per mains cycle:
  s,<ms>,<n>,<r1>,...,<r17>     17 raw current readings in amps, offset already removed;
                                n = number of the first reading, counted from boot

transform() chains two steps:
  parse_line  one text line -> Cycle, or None for anything else
  check       flags a cycle that does not follow on from the one before
"""
import math
from dataclasses import dataclass, replace
from typing import Iterable, Iterator

READINGS_PER_CYCLE = 17
CYCLE_MS = 20                 # one 50 Hz mains cycle
MAX_STEP_MS = 1.5 * CYCLE_MS  # a longer step means at least one cycle is missing


@dataclass(frozen=True)
class Cycle:
    t_ms: int
    n: int                        # number of the first reading, counted from boot
    readings: tuple[float, ...]
    gap_before: bool = False

    @property
    def current_a(self) -> float:
        """Average size of the current (RMS): square, average, square root."""
        return math.sqrt(sum(r * r for r in self.readings) / len(self.readings))

    @property
    def peak_a(self) -> float:
        """Biggest reading, ignoring the sign."""
        return max(abs(r) for r in self.readings)


def parse_line(text: str) -> Cycle | None:
    """Anything that is not a complete s line is None: boot text, notices, cut-off lines."""
    parts = text.strip().split(",")
    if parts[0] != "s" or len(parts) != 3 + READINGS_PER_CYCLE:
        return None
    try:
        return Cycle(int(parts[1]), int(parts[2]), tuple(float(p) for p in parts[3:]))
    except ValueError:
        return None


def check(cycles: Iterable[Cycle]) -> Iterator[Cycle]:
    """gap_before is set when a reading is missing (n is not the last n + 17), or the time jumps more
    than MAX_STEP_MS or goes backwards (board restart). A dropped line shows up here as a gap."""
    prev = None
    for c in cycles:
        if prev is not None:
            dt = c.t_ms - prev.t_ms
            if c.n != prev.n + READINGS_PER_CYCLE or dt <= 0 or dt > MAX_STEP_MS:
                c = replace(c, gap_before=True)
        prev = c
        yield c


def transform(lines: Iterable[str]) -> Iterator[Cycle]:
    return check(c for c in map(parse_line, lines) if c is not None)
