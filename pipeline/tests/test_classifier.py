import numpy as np

from helpers import NearestModel, sig, shape, wave
from shp.classifier import UNKNOWN, classify, off_candidates, on_candidates
from shp.house import House
from shp.library import Library, TeachSession
from shp.settings import Settings

S = Settings(threshold_a=0.05)
KETTLE = shape(wave(8.7, third=0.1))
HEATER = shape(np.sin)
CHARGER = shape(wave(0.15, third=0.6))


def device(name, step, steady):
    t = TeachSession(name, S)
    for i in range(3):
        t.add(sig(step + 5 * i, steady))
        t.add(sig(step + 5 * i, steady, direction=-1))
    return t.finish()


def test_empty_library_gives_unknown():
    p = classify(sig(2000, KETTLE), on_candidates(Library(), S), NearestModel())
    assert p.label == UNKNOWN and p.ranked == ()


def test_one_device_uses_the_match_score_not_p_1():
    lib = Library([device("kettle", 2000, KETTLE)])
    near_kettle = shape(wave(8.7, third=0.12))
    p = classify(sig(2000, near_kettle), on_candidates(lib, S), NearestModel())
    assert p.label == "kettle" and p.source == "match" and p.power_match
    assert 0 < p.p < 1


def test_one_device_wrong_shape_gives_unknown_with_nearest():
    lib = Library([device("kettle", 2000, KETTLE)])
    p = classify(sig(2000, CHARGER), on_candidates(lib, S), NearestModel())
    assert p.label == UNKNOWN
    assert p.nearest == "kettle" and p.nearest_distance > 0.1


def test_power_check_rules_out_wrong_size():
    lib = Library([device("kettle", 2000, KETTLE)])
    p = classify(sig(500, KETTLE), on_candidates(lib, S), NearestModel())
    assert p.label == UNKNOWN and not p.power_match


def test_two_devices_go_to_timee():
    lib = Library([device("kettle", 2000, KETTLE), device("heater", 2010, HEATER)])
    model = NearestModel()
    p = classify(sig(2005, HEATER), on_candidates(lib, S), model)
    assert p.label == "heater" and p.source == "timee" and model.calls == 1
    assert [label for label, _ in p.ranked] == ["heater", "kettle"]


def test_no_shape_decides_by_power_and_a_tie_is_unknown():
    lib = Library([device("kettle", 2000, KETTLE), device("heater", 1500, HEATER)])
    p = classify(sig(1990, shape_ok=False, clean=False), on_candidates(lib, S), NearestModel())
    assert p.label == "kettle" and p.source == "power"
    lib = Library([device("kettle", 2000, KETTLE), device("heater", 2000, HEATER)])
    p = classify(sig(2000, shape_ok=False, clean=False), on_candidates(lib, S), NearestModel())
    assert p.label == UNKNOWN


def test_switch_off_only_considers_devices_that_are_on():
    lib = Library([device("kettle", 2000, KETTLE), device("heater", 2010, HEATER)])
    house = House()
    house.switched_on(sig(2000, KETTLE), classify(sig(2000, KETTLE), on_candidates(lib, S), NearestModel()))
    p = classify(sig(2000, CHARGER, direction=-1), off_candidates(house.on_list, lib, S), NearestModel())
    assert p.label == UNKNOWN and not p.matched      # the heater is not on, the shape is not the kettle's


def test_unknown_entry_matches_its_own_shape_at_switch_off():
    lib = Library()
    house = House()
    on = sig(300, CHARGER)
    house.switched_on(on, classify(on, on_candidates(lib, S), NearestModel()))
    p = classify(sig(300, CHARGER, direction=-1), off_candidates(house.on_list, lib, S), NearestModel())
    assert p.label == UNKNOWN and p.ranked      # ranked: it matched the unknown entry
    assert house.switched_off(sig(300, CHARGER, direction=-1), p) is not None


def test_two_identical_lamps_become_one_candidate_label():
    lamp = shape(wave(0.26))
    lib = Library([device("lamp", 60, lamp), device("kettle", 2000, KETTLE)])
    house = House()
    for t in (0, 10):
        on = sig(60, lamp, t_ms=t)
        house.switched_on(on, classify(on, on_candidates(lib, S), NearestModel()))
    cands = off_candidates(house.on_list, lib, S)
    assert [c.label for c in cands] == ["lamp", "lamp"]
    p = classify(sig(60, lamp, direction=-1), cands, NearestModel())
    assert p.label == "lamp" and p.source == "match"     # one label left after removing repeats


def test_shapeless_unknown_entry_is_matched_by_power():
    house = House()
    gap_on = sig(300, shape_ok=False, clean=False)
    house.switched_on(gap_on, classify(gap_on, on_candidates(Library(), S), NearestModel()))
    p = classify(sig(300, CHARGER, direction=-1), off_candidates(house.on_list, Library(), S), NearestModel())
    assert p.matched and p.source == "power"
    assert house.switched_off(sig(300, CHARGER, direction=-1), p) is not None
