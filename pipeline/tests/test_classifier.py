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
    for i in range(5):
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
    # The heater is not on, so it is never considered. The shape is not the kettle's, but a 2000 W drop while only
    # the kettle is on can only be the kettle: switch-offs fall back to the power match.
    assert p.label == "kettle" and p.source == "power" and all(label != "heater" for label, _ in p.ranked)


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


def test_an_appliance_that_varies_between_turns_is_still_named():
    """Measured on the board: a laptop charger's registered turns differed in shape by up to 0.32. A live switch
    0.4 away is still that charger; the allowed variation comes from its own turns, not a fixed number."""
    from shp.extractor import shape_distance
    shapes = [shape(wave(0.28, third=0.3, phase_deg=a)) for a in (0, 8, 16)]
    t = TeachSession("laptop", S)
    for i, sh in enumerate(shapes):
        t.add(sig(60 + i, sh))
        t.add(sig(60 + i, sh, direction=-1))
    lib = Library([t.finish()])
    live = shape(wave(0.28, third=0.3, phase_deg=22))
    nearest = min(shape_distance(live, sh) for sh in shapes)
    assert nearest > lib.devices[0].baseline.shape_limit           # the old fixed rule would say "unknown"
    p = classify(sig(62, live), on_candidates(lib, S), NearestModel())
    assert p.label == "laptop" and p.p > 0
    assert classify(sig(2000, live), on_candidates(lib, S), NearestModel()).label == UNKNOWN   # power still checked


def test_a_switch_off_that_matches_by_power_names_the_appliance_even_if_its_shape_fades():
    """A charger fading out after unplugging gives an odd shape; only listed appliances can switch off."""
    lib = Library([device("jojo", 52, CHARGER)])
    house = House()
    house.switched_on(sig(52, CHARGER), classify(sig(52, CHARGER), on_candidates(lib, S), NearestModel()))
    off = sig(54, shape(np.cos), direction=-1)            # same power, a different (faded) shape
    p = classify(off, off_candidates(house.on_list, lib, S), NearestModel())
    assert p.label == "jojo" and p.source == "power"
    on = classify(sig(52, shape(np.cos)), on_candidates(lib, S), NearestModel())
    assert on.label == UNKNOWN                            # a switch-on still needs its shape to match
