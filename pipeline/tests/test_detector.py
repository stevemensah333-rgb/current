import math
from dataclasses import replace

import pytest

from shp.detector import MAX_AFTER_CYCLES, SURGE_CYCLES, Event, calibrate, detect
from shp.transform import Cycle

THRESHOLD = 0.05


def cycle(i: int, level: float) -> Cycle:
    """A sine cycle at time i * 20 ms whose current_a equals level."""
    amp = level * math.sqrt(2)
    return Cycle(i * 20, i * 17, tuple(amp * math.sin(2 * math.pi * k / 17) for k in range(17)))


def stream(*parts: tuple[float, int]) -> list[Cycle]:
    """stream((0.26, 20), (0.41, 100)) -> 20 cycles at 0.26 A, then 100 at 0.41 A."""
    out = []
    for level, n in parts:
        out += [cycle(len(out), level) for _ in range(n)]
    return out


def test_cycle_helper_gives_requested_current():
    assert math.isclose(cycle(0, 0.41).current_a, 0.41)


def test_switch_on():
    cycles = stream((0.26, 20), (0.41, 100))
    [e] = detect(cycles, THRESHOLD)
    assert e.direction == 1
    assert math.isclose(e.step_a, 0.15)
    assert math.isclose(e.step_va, 34.5)
    assert e.t_ms == cycles[20].t_ms
    assert len(e.before) == 10 and all(math.isclose(c.current_a, 0.26) for c in e.before)
    assert len(e.after) == SURGE_CYCLES
    assert e.settled and e.clean


def test_switch_off():
    [e] = detect(stream((0.41, 20), (0.26, 100)), THRESHOLD)
    assert e.direction == -1
    assert math.isclose(e.step_a, -0.15)
    assert len(e.after) == 20


def test_one_cycle_spike_is_a_blip():
    assert list(detect(stream((0.26, 20), (3.7, 1), (0.26, 100)), THRESHOLD)) == []


def test_surge_then_settle_keeps_the_surge():
    [e] = detect(stream((0.26, 20), (3.7, 1), (0.41, 100)), THRESHOLD)
    assert e.direction == 1
    assert math.isclose(e.step_a, 0.15)
    assert math.isclose(max(c.current_a for c in e.after), 3.7)


def test_two_switches_give_two_events():
    events = list(detect(stream((0.26, 20), (0.41, 100), (0.26, 100)), THRESHOLD))
    assert [e.direction for e in events] == [1, -1]


def test_gap_inside_capture_is_not_clean():
    cycles = stream((0.26, 20), (0.41, 100))
    cycles[30] = replace(cycles[30], gap_before=True)
    [e] = detect(cycles, THRESHOLD)
    assert not e.clean


def test_never_settles_hits_the_limit():
    cycles = stream((0.26, 20))
    cycles += [cycle(20 + i, 0.4 + 0.01 * i) for i in range(MAX_AFTER_CYCLES + 50)]
    e = next(detect(cycles, THRESHOLD))
    assert not e.settled
    assert len(e.after) == MAX_AFTER_CYCLES


def test_switch_hidden_in_gap_is_still_found():
    cycles = stream((0.26, 20), (0.41, 30))
    cycles[20] = replace(cycles[20], gap_before=True)
    [e] = detect(cycles, THRESHOLD)
    assert e.direction == 1
    assert math.isclose(e.step_a, 0.15)
    assert not e.clean
    assert all(math.isclose(c.current_a, 0.26) for c in e.before)


def test_gap_with_no_change_gives_no_event_and_watching_resumes():
    cycles = stream((0.26, 40), (0.41, 100))
    cycles[20] = replace(cycles[20], gap_before=True)
    [e] = detect(cycles, THRESHOLD)
    assert e.t_ms == cycles[40].t_ms and e.clean


def test_calibrate_is_five_times_the_noise():
    quiet = [cycle(i, 0.25 if i % 2 else 0.27) for i in range(100)]
    assert math.isclose(calibrate(quiet), 0.05)


def test_calibrate_needs_cycles():
    with pytest.raises(ValueError):
        calibrate([cycle(0, 0.26)])
