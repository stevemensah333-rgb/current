"""Turns an Event into the device's own signal: what the device adds (on) or removes (off).

  steady  one cycle of the device's own wave, 50 points, RMS 1, starting at its upward zero crossing
  surge   switch-on only: (current of after cycle i - before level) / |step| for the first 50 after cycles

Before and after are fitted against one shared clock: reading number n (from the board's counter)
and the measured mains cycles per reading. See DESIGN.md, stage 3.
"""
import math
from dataclasses import dataclass

import numpy as np

from shp.detector import STEADY_CYCLES, SURGE_CYCLES, Event
from shp.settings import MAINS_V, NOMINAL_CYCLES_PER_READING, Settings
from shp.transform import CYCLE_MS, Cycle

HARMONICS = 8      # 17 readings per cycle carry up to the 8th
SHAPE_POINTS = 50  # same length as the surge, so both channels match


@dataclass(frozen=True)
class Signature:
    direction: int
    t_ms: int
    steady: tuple[float, ...]   # 50 points, RMS 1; empty if not shape_ok
    surge: tuple[float, ...]    # 50 points, switch-on with shape only
    size_a: float               # RMS of the device's own wave
    step_a: float
    settle_ms: int
    clean: bool
    settled: bool
    shape_ok: bool
    low_trust: bool
    clock: str                  # where the clock came from: "before", "after", "stored", "nominal",
                                # or "none" (a gap: no clock, no shape)

    @property
    def step_va(self) -> float:
        return MAINS_V * self.step_a


def _level(cycles) -> float:
    return float(np.mean([c.current_a for c in cycles]))


def _positions_and_values(cycles, first_reading: int):
    """Every reading's position (counted from first_reading) and its value."""
    positions = np.concatenate([c.n - first_reading + np.arange(len(c.readings)) for c in cycles])
    values = np.concatenate([c.readings for c in cycles])
    return positions.astype(float), values


def fit_waves(cycles, first_reading: int, cycles_per_reading: float) -> np.ndarray:
    """Least-squares fit of the main wave and 7 ripples at the true reading positions.
    Returns one complex number per wave, C[h-1], so that
    reading(k) = sum over h of Re(C_h * exp(i h w k)),  w = 2 pi x cycles_per_reading."""
    k, x = _positions_and_values(cycles, first_reading)
    w = 2 * math.pi * cycles_per_reading
    cols = [np.ones_like(k)]
    for h in range(1, HARMONICS + 1):
        cols += [np.cos(h * w * k), np.sin(h * w * k)]
    coef, *_ = np.linalg.lstsq(np.column_stack(cols), x, rcond=None)
    a, b = coef[1::2], coef[2::2]
    return a - 1j * b


def measure_clock(cycles, cycles_per_reading: float = NOMINAL_CYCLES_PER_READING) -> float:
    """Mains cycles per reading from a steady stretch: if the main wave creeps from line to line,
    the creep gives the correction. Two passes, so a start value off by ~10 % still converges."""
    first = cycles[0].n
    for _ in range(2):
        mids, angles = [], []
        for c in cycles:
            main_wave = fit_waves([c], first, cycles_per_reading)[0]
            mids.append(c.n - first + (len(c.readings) - 1) / 2)
            angles.append(np.angle(main_wave))
        creep = np.polyfit(mids, np.unwrap(angles), 1)[0]  # radians per reading
        cycles_per_reading += creep / (2 * math.pi)
    return float(cycles_per_reading)


def settle_index(event: Event, threshold_a: float) -> int:
    """First after cycle from which current_a stays within threshold_a of the settled level."""
    after = event.after
    level = _level(after[-STEADY_CYCLES:])
    i = len(after)
    while i > 0 and abs(after[i - 1].current_a - level) <= threshold_a:
        i -= 1
    return min(i, len(after) - STEADY_CYCLES)


def _own_shape(own: np.ndarray) -> tuple[tuple[float, ...], float]:
    """Slide the wave so its main wave crosses zero going up at the start, rebuild 50 points,
    scale to RMS 1. Ripple h turns h times as far as the main wave."""
    turn = -math.pi / 2 - np.angle(own[0])
    h = np.arange(1, HARMONICS + 1)
    aligned = own * np.exp(1j * h * turn)
    theta = 2 * math.pi * np.arange(SHAPE_POINTS) / SHAPE_POINTS
    wave = np.real(aligned[None, :] * np.exp(1j * np.outer(theta, h))).sum(axis=1)
    size = float(np.sqrt(np.mean(wave ** 2)))
    if size == 0:
        return (), 0.0
    return tuple(float(v) for v in wave / size), size


def extract(event: Event, settings: Settings) -> Signature:
    th = settings.threshold_a
    s = settle_index(event, th)
    settle_ms = s * CYCLE_MS
    before_level = _level(event.before)
    low_trust = abs(event.step_a) < settings.low_trust_ratio * before_level

    def no_shape(clock: str, low: bool) -> Signature:
        # No wave to measure, so size_a falls back to the step size.
        return Signature(event.direction, event.t_ms, (), (), abs(event.step_a), event.step_a,
                         settle_ms, event.clean, event.settled, False, low, clock)

    if not event.clean:
        return no_shape("none", low_trust)

    before = list(event.before)
    after = list(event.after[s:s + STEADY_CYCLES])
    clock_min = settings.clock_min_level_mult * th
    if before_level > clock_min:
        cpr, clock = measure_clock(before), "before"   # cpr: mains cycles per reading
        if s > settings.max_carry_cycles:
            low_trust = True
    elif _level(after) > clock_min:
        cpr, clock = measure_clock(after), "after"
    elif settings.cycles_per_reading:
        cpr, clock = settings.cycles_per_reading, "stored"
    else:
        cpr, clock, low_trust = NOMINAL_CYCLES_PER_READING, "nominal", True

    first = event.before[0].n
    own = fit_waves(after, first, cpr) - fit_waves(before, first, cpr)
    if event.direction < 0:
        own = -own
    steady, size_a = _own_shape(own)
    if not steady:
        return no_shape(clock, low_trust)

    surge = ()
    if event.direction > 0:
        step = abs(event.step_a)
        surge = tuple((c.current_a - before_level) / step for c in event.after[:SURGE_CYCLES])

    return Signature(event.direction, event.t_ms, steady, surge, size_a, event.step_a, settle_ms,
                     event.clean, event.settled, True, low_trust, clock)


def shape_distance(a, b) -> float:
    """RMS of the difference between two steady shapes."""
    return float(np.sqrt(np.mean((np.asarray(a) - np.asarray(b)) ** 2)))
