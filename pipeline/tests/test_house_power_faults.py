from helpers import cycles_from, sig, shape, total, wave
from shp.classifier import Prediction
from shp.faults import FaultMonitor
from shp.house import House
from shp.library import Library, TeachSession
from shp.power import PowerMonitor
from shp.settings import Settings

S = Settings(threshold_a=0.05)
LAMP = shape(wave(0.26))


def pred(label, p=0.9, matched=True, power_match=True, nearest=None):
    return Prediction(label, p, ((label, p),) if matched else (), power_match, "match",
                      matched=matched, nearest=nearest, nearest_distance=0.0)


# house state

def test_two_identical_lamps_can_both_be_on():
    h = House()
    h.switched_on(sig(60, LAMP, t_ms=0), pred("lamp"))
    h.switched_on(sig(62, LAMP, t_ms=10), pred("lamp"))
    assert h.summary() == "lamp ON 0.90, lamp ON 0.90"
    removed = h.switched_off(sig(62, LAMP, direction=-1, t_ms=20), pred("lamp"))
    assert removed.step_va == 62 and len(h.on_list) == 1


def test_unexplained_switch_off_removes_nothing():
    h = House()
    h.switched_on(sig(60, LAMP), pred("lamp"))
    assert h.switched_off(sig(2000, direction=-1), pred("unknown", 0.0, matched=False)) is None
    assert len(h.on_list) == 1 and "unexplained" in h.notes[0]


def test_usage_merges_settings_and_counts_hours():
    h = House()
    hour = 3_600_000
    h.switched_on(sig(200, t_ms=0), pred("mixer|speed 3"))
    h.switched_off(sig(200, direction=-1, t_ms=hour), pred("mixer|speed 3"))
    hours, vah = h.usage("mixer", 0, 2 * hour)
    assert hours == 1 and vah == 200


# power monitor

def test_steady_power_raises_nothing():
    pm = PowerMonitor(S)
    flags = [pm.feed(c)[1] for c in cycles_from([(500, wave(4.0))])]
    assert not any(flags)


def test_unseen_step_is_a_missed_event():
    pm = PowerMonitor(S)
    flags = [pm.feed(c)[1] for c in cycles_from([(300, wave(4.0)), (500, total(wave(4.0), wave(2.0)))])]
    kinds = [f.kind for f in flags if f]
    assert kinds == ["missed event"]


def test_slow_creep_is_grid_drift():
    pm = PowerMonitor(S)
    cycles = []
    for i in range(30):        # +0.03 A per second for 30 s
        cycles += cycles_from([(50, wave(4.0 + 0.03 * i))], start=50 * i, seed=i)
    kinds = [f.kind for f in (pm.feed(c)[1] for c in cycles) if f]
    assert kinds and set(kinds) == {"grid drift"}


def test_reanchor_after_event_clears_the_drift():
    # The step lands mid-second (cycle 325) and the event is reported 20 cycles later, as a
    # switch-off would be. The second in progress mixes both levels and must not become the anchor.
    pm = PowerMonitor(S)
    cycles = cycles_from([(325, wave(12.7)), (500, wave(4.0))])
    flags = []
    for i, c in enumerate(cycles):
        if i == 345:
            pm.reanchor(230 * 4.0)
        flags.append(pm.feed(c)[1])
    assert not any(flags)


def test_energy_follows_board_time():
    pm = PowerMonitor(S)
    for c in cycles_from([(50 * 3600, wave(1.0))]):   # one hour at 1 A
        pm.feed(c)
    assert abs(pm.energy_vah - 230) < 0.5


# fault monitor

def lamp_library():
    t = TeachSession("lamp", S)
    for i in range(3):
        t.add(sig(60 + i, LAMP, settle_ms=40))
        t.add(sig(60 + i, LAMP, direction=-1))
    return Library([t.finish()])


def test_three_days_of_slow_settling_raises_one_alert():
    lib, fm = lamp_library(), FaultMonitor(S)
    for day in (1, 2, 3, 4):
        fm.log(sig(60, LAMP, settle_ms=400), pred("lamp"), lib, day)
    alerts = fm.check(lib)
    assert [(a.day, a.value) for a in alerts] == [(3, "settle_ms")]
    assert fm.check(lib) == []     # not raised twice


def test_normal_days_raise_nothing_and_grid_swing_is_ignored():
    lib, fm = lamp_library(), FaultMonitor(S)
    for day in range(1, 6):
        fm.log(sig(66, LAMP, settle_ms=40), pred("lamp"), lib, day)   # +10 % grid swing
    assert fm.check(lib) == []


def test_unknown_switch_on_is_logged_against_its_nearest_device():
    lib, fm = lamp_library(), FaultMonitor(S)
    row = fm.log(sig(90, LAMP), pred("unknown", 0.0, matched=False, power_match=False, nearest="lamp"), lib, 1)
    assert row.unknown and row.label == "lamp"


def test_low_trust_switch_on_is_not_logged():
    lib, fm = lamp_library(), FaultMonitor(S)
    assert fm.log(sig(60, LAMP, low_trust=True), pred("lamp"), lib, 1) is None


def test_days_with_a_break_are_not_a_streak():
    lib, fm = lamp_library(), FaultMonitor(S)
    for day in (1, 5, 9):
        fm.log(sig(60, LAMP, settle_ms=400), pred("lamp"), lib, day)
    assert fm.check(lib) == []


def test_settings_save_and_load(tmp_path):
    from shp.settings import Settings as St
    s = St(threshold_a=0.031, cycles_per_reading=0.0589)
    s.save(tmp_path / "settings.json")
    assert St.load(tmp_path / "settings.json") == s


def test_health_is_ok_then_watch_then_alert():
    lib, fm = lamp_library(), FaultMonitor(S)
    assert fm.health("lamp", lib) is None                                      # no data yet
    fm.log(sig(60, LAMP, settle_ms=40), pred("lamp"), lib, 1)
    h = fm.health("lamp", lib)
    assert h["status"] == "ok" and h["samples"] == 1 and h["settle_low"] <= 40 <= h["settle_high"]
    fm.log(sig(60, LAMP, settle_ms=400), pred("lamp"), lib, 2)
    assert fm.health("lamp", lib)["status"] == "watch" and fm.health("lamp", lib)["days_outside"] == 1
    for day in (3, 4):
        fm.log(sig(60, LAMP, settle_ms=400), pred("lamp"), lib, day)
    assert fm.health("lamp", lib)["status"] == "alert" and fm.health("lamp", lib)["days_outside"] == 3
