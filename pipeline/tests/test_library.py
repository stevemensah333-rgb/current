import numpy as np
import pytest

from helpers import sig, shape, wave
from shp.library import Library, TeachSession, mad
from shp.settings import Settings

S = Settings(threshold_a=0.05)
KETTLE = shape(wave(8.7, third=0.1))


def taught(name="kettle", step=2000, steady=KETTLE, rounds=5, setting=None):
    t = TeachSession(name, S, setting)
    for i in range(rounds):
        t.add(sig(step + 5 * i, steady))
        t.add(sig(step + 5 * i, steady, direction=-1))
    return t


def turn(t, step, steady=KETTLE, off_step=None, off_steady=None):
    """One turn: a switch-on, then a switch-off. Returns the switch-off's Turn."""
    t.add(sig(step, steady))
    return t.add(sig(step if off_step is None else off_step, steady if off_steady is None else off_steady,
                     direction=-1))


def test_mad_example_from_the_design():
    assert mad([2000, 2010, 2500]) == 10


def test_a_turn_is_a_switch_on_then_its_switch_off():
    t = TeachSession("kettle", S)
    first = t.add(sig(2000, KETTLE))
    assert first.status == "waiting" and "Now switch it off" in first.message and t.turns == []
    kept = t.add(sig(2000, KETTLE, direction=-1))
    assert kept.status == "kept" and kept.number == 1 and "turn 1 of 5 kept" in kept.message
    assert len(t.turns) == 1 and t.on[0].direction == 1 and t.off[0].direction == -1


def test_exactly_five_turns_then_finished():
    t = taught(rounds=4)
    assert not t.ready
    with pytest.raises(ValueError):
        t.finish()
    last = turn(t, 2020)
    assert t.ready and "all 5 turns done" in last.message
    assert t.add(sig(2000, KETTLE)).status == "ignored"      # a sixth switch is not used
    entry = t.finish()
    assert len(entry.on_examples) == 5 and len(entry.off_examples) == 5   # kept separately, not averaged


def test_odd_power_is_a_redo_and_kept_turns_stay():
    t = TeachSession("kettle", S)
    turn(t, 2000)
    turn(t, 2010)
    odd = turn(t, 2500)
    assert odd.status == "redo" and "far from the other turns" in odd.message and "Do turn 3 again" in odd.message
    assert [round(abs(s.step_va)) for s in t.on] == [2000, 2010]
    assert turn(t, 2005).number == 3


def test_odd_shape_is_a_redo():
    t = TeachSession("kettle", S)
    turn(t, 2000)
    turn(t, 2000)
    odd = turn(t, 2000, steady=shape(np.cos))
    assert odd.status == "redo" and "shape is different" in odd.message and len(t.turns) == 2


def test_switch_off_must_match_its_switch_on():
    t = TeachSession("kettle", S)
    r = turn(t, 2000, off_step=1500)
    assert r.status == "redo" and "did not match" in r.message and t.turns == []


def test_untrusted_switches_are_refused_and_do_not_count():
    t = TeachSession("kettle", S)
    assert "other big loads" in t.add(sig(2000, low_trust=True)).message
    assert "readings were lost" in t.add(sig(2000, clean=False)).message
    assert "never settled" in t.add(sig(2000, settled=False)).message
    assert t.turns == [] and t.redos == 0
    assert t.add(sig(2000, KETTLE, direction=-1)).status == "ignored"   # an off with no on before it
    assert turn(t, 2000).number == 1


def test_device_that_varies_stops_after_max_redos():
    t = TeachSession("lamp", S)
    for _ in range(S.max_redos):
        r = turn(t, 100, off_step=300)
    assert t.varies and "varies a lot" in r.message


def test_each_turn_keeps_its_raw_waveform():
    from helpers import cycles_from, wave as w
    from shp.detector import detect
    from shp.extractor import extract
    s = Settings(threshold_a=0.05)
    t = TeachSession("heater", s)
    stream = cycles_from([(30, lambda x: 0 * x), (120, w(4.0)), (60, lambda x: 0 * x)], seed=3)
    turns = [t.add(extract(e, s), e) for e in detect(stream, s.threshold_a)]
    kept = turns[-1]
    assert kept.status == "kept"
    wf = kept.waveform
    assert wf["readings_per_cycle"] == 17
    assert len(wf["on"]["before"]) == 10 and len(wf["on"]["after"]) >= 50
    assert len(wf["off"]["before"]) == 10 and all(len(c) == 17 for c in wf["off"]["after"])
    # the raw readings themselves: about 4 A RMS after the switch-on
    after = np.array(wf["on"]["after"][-10:])
    assert abs(np.sqrt(np.mean(after ** 2)) - 4.0) < 0.1


def test_baseline_ranges_have_floors():
    b = taught().finish().baseline
    assert b.step_va.high - b.step_va.mean >= 0.1 * b.step_va.mean   # 10 % floor
    assert b.settle_ms.high - b.settle_ms.mean >= 20                 # one cycle
    assert b.shape_limit >= S.shape_floor


def test_settings_share_a_name():
    entry = taught("mixer", setting="speed 3").finish()
    assert entry.label == "mixer|speed 3"


def test_save_and_load(tmp_path):
    lib = Library()
    lib.add_device(taught().finish())
    lib.save(tmp_path / "library.json")
    back = Library.load(tmp_path / "library.json")
    assert back.devices == lib.devices


class P:  # the parts of a Prediction add_live reads
    def __init__(self, label="kettle", p=0.95, power_match=True):
        self.label, self.p, self.power_match = label, p, power_match


def test_working_library_takes_only_confident_clean_switch_ons():
    lib = Library([taught().finish()])
    assert lib.add_live(sig(2000, KETTLE), P(), S)
    assert not lib.add_live(sig(2000, KETTLE), P(p=0.5), S)
    assert not lib.add_live(sig(2000, KETTLE), P(power_match=False), S)
    assert not lib.add_live(sig(2000, KETTLE, low_trust=True), P(), S)
    assert not lib.add_live(sig(2000, KETTLE, direction=-1), P(), S)
    for _ in range(30):
        lib.add_live(sig(2000, KETTLE), P(), S)
    assert len(lib.devices[0].live_examples) == S.working_per_device
