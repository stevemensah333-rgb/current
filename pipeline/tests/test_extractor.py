"""Extractor tests on hand-built readings with known waves.

Readings are made at a mains rate that is not the nominal 50/860, so the clock must be measured.
"""
import math
from dataclasses import replace

import numpy as np

from shp.detector import detect
from shp.extractor import extract, measure_clock, shape_distance
from shp.settings import Settings
from shp.transform import Cycle

CPR = 50.03 / 850          # true mains cycles per reading, ~1.2 % off nominal
S = Settings(threshold_a=0.05)
RT2 = math.sqrt(2)


def kettle(theta):         # 8.7 A main wave + 10 % third ripple, starts at its upward zero crossing
    return RT2 * 8.7 * (np.sin(theta) + 0.1 * np.sin(3 * theta))


def fridge(theta):
    return RT2 * 1.0 * np.sin(theta + math.radians(40))


def charger(theta):
    return RT2 * 0.15 * np.sin(theta + math.radians(-30))


def lines(segments, noise=0.003, gap_at=None):
    """segments: list of (n_cycles, wave function of theta, gain for the first cycle of the segment)."""
    rng = np.random.default_rng(0)
    out, j = [], 0
    for n_cycles, fn, first_gain in segments:
        for i in range(n_cycles):
            k = 17 * j + np.arange(17)
            theta = 2 * math.pi * CPR * k + 0.7       # arbitrary start of the mains wave
            x = fn(theta) * (first_gain if i == 0 else 1.0) + rng.normal(0, noise, 17)
            out.append(Cycle(20 * j, 17 * j, tuple(float(v) for v in x)))
            j += 1
    if gap_at is not None:
        out[gap_at] = replace(out[gap_at], gap_before=True)
    return out


def reference(fn):
    theta = 2 * math.pi * np.arange(50) / 50
    w = fn(theta)
    return w / np.sqrt(np.mean(w ** 2))


def only_event(cycles):
    [e] = detect(cycles, S.threshold_a)
    return e


def test_measure_clock_finds_true_rate():
    cycles = lines([(10, fridge, 1.0)])
    # 5e-6 cycles per reading is under 0.4 degrees across a 200-reading event
    assert abs(measure_clock(cycles) - CPR) < 5e-6


def test_kettle_on_with_fridge_on():
    e = only_event(lines([(30, fridge, 1.0), (150, lambda t: fridge(t) + kettle(t), 1.0)]))
    sig = extract(e, S)
    assert sig.direction == 1 and sig.shape_ok and not sig.low_trust
    assert sig.clock == "before"
    assert shape_distance(sig.steady, reference(kettle)) < 0.01
    assert math.isclose(sig.size_a, 8.7 * math.sqrt(1.01), rel_tol=0.01)
    assert len(sig.surge) == 50 and abs(sig.surge[-1] - 1) < 0.05


def test_surge_is_kept():
    surge_kettle = lines([(30, fridge, 1.0), (150, lambda t: fridge(t) + kettle(t), 1.0)])
    for i in (30, 31):  # first two kettle cycles draw 50 % more
        surge_kettle[i] = replace(surge_kettle[i], readings=tuple(1.5 * r for r in surge_kettle[i].readings))
    sig = extract(only_event(surge_kettle), S)
    assert math.isclose(sig.surge[0], 1.56, rel_tol=0.03)   # (1.5 x 9.6 A - 1.0 A) / 8.6 A


def test_kettle_off_gives_the_same_shape():
    e = only_event(lines([(30, lambda t: fridge(t) + kettle(t), 1.0), (60, fridge, 1.0)]))
    sig = extract(e, S)
    assert sig.direction == -1 and sig.surge == ()
    assert shape_distance(sig.steady, reference(kettle)) < 0.01


def test_quiet_house_takes_the_clock_from_after():
    sig = extract(only_event(lines([(30, lambda t: 0 * t, 1.0), (150, kettle, 1.0)])), S)
    assert sig.clock == "after"
    assert shape_distance(sig.steady, reference(kettle)) < 0.01


def test_small_device_on_big_load_is_low_trust():
    e = only_event(lines([(30, lambda t: fridge(t) + kettle(t), 1.0),
                          (150, lambda t: fridge(t) + kettle(t) + charger(t), 1.0)], noise=0.001))
    assert extract(e, S).low_trust


def test_small_device_in_quiet_house_uses_stored_clock():
    cycles = lines([(30, lambda t: 0 * t, 1.0), (150, charger, 1.0)], noise=0.001)
    e = only_event(cycles)
    assert extract(e, S).clock == "nominal" and extract(e, S).low_trust
    sig = extract(e, Settings(threshold_a=0.05, cycles_per_reading=CPR))
    assert sig.clock == "stored" and not sig.low_trust
    assert shape_distance(sig.steady, reference(np.sin)) < 0.02   # aligned at its own zero crossing


def test_gap_event_has_no_shape():
    e = only_event(lines([(30, fridge, 1.0), (150, lambda t: fridge(t) + kettle(t), 1.0)], gap_at=40))
    sig = extract(e, S)
    assert not sig.shape_ok and sig.steady == () and sig.surge == ()


def ramp_on(n_ramp):
    """Fridge on; a kettle that takes n_ramp cycles to reach full current."""
    segs = [(30, fridge, 1.0)]
    segs += [(1, (lambda g: lambda t: fridge(t) + g * kettle(t))((i + 1) / n_ramp), 1.0) for i in range(n_ramp)]
    segs += [(150, lambda t: fridge(t) + kettle(t), 1.0)]
    return lines(segs)


def test_settle_time_is_measured():
    sig = extract(only_event(ramp_on(40)), S)
    assert abs(sig.settle_ms - 40 * 20) <= 40


def test_clock_carried_far_is_low_trust():
    assert not extract(only_event(ramp_on(10)), S).low_trust
    assert extract(only_event(ramp_on(40)), S).low_trust     # after group starts > 25 cycles later
