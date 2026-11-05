import numpy as np
import pytest

from helpers import sig, shape, wave
from shp.library import Library, TeachSession, mad
from shp.settings import Settings

S = Settings(threshold_a=0.05)
KETTLE = shape(wave(8.7, third=0.1))


def taught(name="kettle", step=2000, steady=KETTLE, rounds=3, setting=None):
    t = TeachSession(name, S, setting)
    for i in range(rounds):
        t.add(sig(step + 5 * i, steady))
        t.add(sig(step + 5 * i, steady, direction=-1))
    return t


def test_mad_example_from_the_design():
    assert mad([2000, 2010, 2500]) == 10


def test_odd_round_is_dropped():
    t = TeachSession("kettle", S)
    for step in (2000, 2010):
        t.add(sig(step, KETTLE))
    msg = t.add(sig(2500, KETTLE))
    assert "odd round dropped" in msg
    assert [round(abs(s.step_va)) for s in t.on] == [2000, 2010]


def test_odd_shape_is_dropped():
    t = TeachSession("kettle", S)
    t.add(sig(2000, KETTLE))
    t.add(sig(2000, KETTLE))
    assert "odd round dropped" in t.add(sig(2000, shape(np.cos)))


def test_untrusted_rounds_are_refused():
    t = TeachSession("kettle", S)
    assert t.add(sig(2000, low_trust=True)).startswith("refused: other big loads")
    assert t.add(sig(2000, clean=False)).startswith("refused: readings were lost")
    assert t.add(sig(2000, settled=False)).startswith("refused: the device never settled")
    assert t.on == []


def test_finish_needs_three_on_and_off_rounds():
    t = taught(rounds=2)
    with pytest.raises(ValueError):
        t.finish()
    assert taught(rounds=3).ready


def test_device_that_varies_stops_after_max_rounds():
    t = TeachSession("lamp", S)
    for _ in range(S.max_rounds):
        msg = t.add(sig(100, low_trust=True))
    assert t.varies and "varies a lot" in msg


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
