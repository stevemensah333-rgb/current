from helpers import NearestModel, cycles_from, shape, sig, total, wave
from shp.app import Pipeline
from shp.classifier import Prediction
from shp.control import Controller, NoSwitch
from shp.detector import detect
from shp.extractor import extract
from shp.house import House
from shp.library import Library, TeachSession
from shp.settings import Settings

S = Settings(threshold_a=0.05)


class Scripted:
    """Stand-in chat model that replays a list of replies."""

    def __init__(self, *replies):
        self.replies, self.seen = list(replies), []

    def chat(self, messages, tools):
        self.seen.append(([m["role"] for m in messages], [t["function"]["name"] for t in tools]))
        return self.replies.pop(0) if self.replies else {"content": "done", "tool_calls": []}


def call(name, **args):
    return {"content": "", "tool_calls": [{"id": "1", "name": name, "arguments": args}]}


def house_with_mixer():
    h = House()
    h.switched_on(sig(200, t_ms=0), Prediction("mixer|speed 3", 0.9, (("mixer|speed 3", 0.9),), True, "match"))
    return h


def test_switch_off_needs_the_device_on_and_the_user_to_confirm():
    sw = NoSwitch()
    c = Controller(house_with_mixer(), Scripted(call("switch_off", device="kettle"),
                                                call("switch_off", device="mixer")), S, switch=sw)
    c.ask("switch things off")
    results = [m for m in c.model.seen[-1][0]]
    assert results.count("tool") == 2
    assert sw.requests == []       # the user never confirmed


def test_confirmed_switch_off_reaches_the_switch():
    sw = NoSwitch()
    c = Controller(house_with_mixer(), Scripted(call("switch_off", device="mixer")), S,
                   switch=sw, confirm=lambda d: True)
    c.ask("switch the mixer off")
    assert sw.requests == ["mixer"]


def test_alert_may_only_notify():
    shown = []
    model = Scripted(call("switch_off", device="mixer"), call("notify_user", message="check the mixer"))
    c = Controller(house_with_mixer(), model, S, confirm=lambda d: True, notify=shown.append)
    c.on_alert("mixer: settle_ms outside its normal range")
    assert model.seen[0][1] == ["notify_user"]
    assert shown == ["check the mixer"]


def test_loop_stops_after_max_rounds():
    model = Scripted(*[call("get_usage", device="mixer", period="day")] * 10)
    c = Controller(house_with_mixer(), model, S, now_ms=lambda: 3_600_000)
    assert c.ask("usage?") == f"Stopped after {S.max_tool_rounds} tool rounds."


# whole pipeline: teach two devices, then run a stream through every stage

KETTLE = wave(8.7, third=0.1)
FRIDGE = wave(1.0, phase_deg=40, third=0.05)


def teach(name, fn, s):
    session = TeachSession(name, s)
    stream = cycles_from([(30, lambda t: 0 * t), (120, fn), (60, lambda t: 0 * t)] * 5, seed=1)
    for e in detect(stream, s.threshold_a):
        session.add(extract(e, s), e)
    return session.finish()


def test_pipeline_names_devices_and_tracks_the_house():
    s = Settings(threshold_a=0.05)
    lib = Library([teach("kettle", KETTLE, s), teach("fridge", FRIDGE, s)])
    pipe = Pipeline(s, lib, NearestModel(), now_ms=None)
    stream = cycles_from([(30, lambda t: 0 * t), (120, FRIDGE), (120, total(FRIDGE, KETTLE)),
                          (120, FRIDGE), (120, lambda t: 0 * t)], seed=2)
    messages = []
    for c in stream:
        messages += pipe.feed(c)
    states = [m for m in messages if m.startswith("state:")]
    assert not [m for m in messages if m.startswith("power:")]   # every step was seen
    names = [[part.split(" ON")[0] for part in st[len("state: "):].split(", ")] for st in states]
    assert names == [["fridge"], ["fridge", "kettle"], ["fridge"], ["nothing on"]]
    assert pipe.house.on_list == []
    assert [c.label for c in pipe.house.log] == ["fridge", "kettle", "kettle", "fridge"]


def test_small_drift_is_not_named_listed_or_alerted():
    from shp.app import Pipeline
    from helpers import NearestModel, cycles_from, wave
    s = Settings(threshold_a=0.02)
    pipe = Pipeline(s, Library(), NearestModel(), now_ms=None)
    # a charger drawing 0.25 A that dips by 0.05 A (about 12 W) for a while
    for c in cycles_from([(60, wave(0.25)), (120, wave(0.20)), (120, wave(0.25))], seed=3):
        pipe.feed(c)
    assert not [f for f in pipe.flags if f["kind"] == "unexplained_off"]
    assert all(abs(sig.step_va) >= s.min_event_va for _, sig, _ in pipe.events)


def test_a_silent_board_is_reopened(monkeypatch):
    """A stalled USB-serial chip stays 'connected' but sends nothing; the source must reopen the port."""
    import itertools
    from shp import sources
    opened = []

    class Port:
        def __init__(self, lines):
            self.lines = iter(lines)
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def readline(self):
            return next(self.lines, b"")

    scripts = iter([[b"s,1\n", b"s,2\n"], [b"s,3\n"]])   # first open: 2 lines then silence; second open: 1 line

    def opener(*a, **k):
        opened.append(1)
        return Port(next(scripts))
    monkeypatch.setattr(sources.time, "sleep", lambda s: None)   # no real waiting in the test
    out = list(itertools.islice(sources.from_serial("COM9", opener=opener, silent_s=0), 3))
    assert out == ["s,1", "s,2", "s,3"] and len(opened) == 2
