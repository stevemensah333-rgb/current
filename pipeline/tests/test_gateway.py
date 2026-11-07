import json

import pytest

import shp.gateway as gw
from helpers import NearestModel, cycles_from, total, wave
from shp.app import Pipeline
from shp.detector import detect
from shp.extractor import extract
from shp.gateway import Clock, Gateway, Outbox, channel_id, connect
from shp.house import House
from shp.library import Library, TeachSession
from shp.settings import Settings

S = Settings(threshold_a=0.05)
KETTLE = wave(8.7, third=0.1)
FRIDGE = wave(1.0, phase_deg=40, third=0.05)
OFF = lambda t: 0 * t   # noqa: E731


def test_channel_ids_are_safe():
    assert channel_id("Kitchen Kettle") == "kitchen-kettle"
    assert channel_id("mixer|speed 3") == "mixer"
    assert channel_id("Ünïcode !!") == "n-code"
    assert len(channel_id("x" * 80)) == 48


# outbox

def test_outbox_resends_the_same_bytes_and_drops_refused_messages():
    sent, answers = [], [OSError(), 503, 200, 400, 200]

    def send(path, body):
        sent.append(body)
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a
    now = {"t": 0}
    box = Outbox(send, lambda: now["t"])
    box.put("/r", {"b": 1, "a": 2})
    box.put("/r", {"bad": True})
    box.put("/r", {"c": 3})
    box.flush()                        # network error: kept
    box.flush()                        # too soon: no new try
    assert len(sent) == 1
    now["t"] += gw.RETRY_MS
    box.flush()                        # 503: kept
    now["t"] += gw.RETRY_MS
    box.flush()                        # 200, then 400 dropped, then 200
    assert sent[0] == sent[1] == sent[2] == b'{"b":1,"a":2}'
    assert len(box.queue) == 0 and sent[-1] == b'{"c":3}'


def test_outbox_drops_messages_older_than_ten_minutes():
    now = {"t": 0}
    box = Outbox(lambda p, b: (_ for _ in ()).throw(OSError()), lambda: now["t"])
    box.put("/r", {"a": 1})
    now["t"] = 11 * 60 * 1000
    box.flush()
    assert len(box.queue) == 0


# clock

def test_clock_never_goes_back_never_ahead_and_corrects_slowly():
    now = {"t": 100_000}
    clock = Clock(lambda: now["t"])
    clock.update(98_000)                          # PC is 2 s ahead of the pipeline's wall time
    assert clock.stamp(98_000, "a") == 98_000     # no jump
    for i in range(1, 11):                        # 10 s later the correction is at most 100 ms
        now["t"] += 1000
        clock.update(98_000 + 1000 * i)
    assert 0 < clock.correction <= 100
    t1 = clock.stamp(50_000, "a")                 # an earlier wall time still moves forward
    assert t1 > 98_000
    assert clock.stamp(10 ** 12, "b") == now["t"]  # never later than now


# gateway on a real pipeline run

def teach(name, fn):
    session = TeachSession(name, S, kind=name, room="Kitchen")
    for e in detect(cycles_from([(30, OFF), (120, fn), (60, OFF)] * 5, seed=1), S.threshold_a):
        session.add(extract(e, S), e)
    return session.finish()


@pytest.fixture(scope="module")
def library():
    return Library([teach("kettle", KETTLE), teach("fridge", FRIDGE)])


def run_gateway(library, segments):
    posted, now = [], {"t": 0}
    pipe = Pipeline(S, library, NearestModel(), now_ms=lambda: 0)
    box = Outbox(lambda path, body: posted.append((path, json.loads(body))) or 200, lambda: now["t"])
    g = Gateway(pipe, box, Clock(lambda: now["t"]))
    for c in cycles_from(segments, seed=2):
        now["t"] = c.t_ms + 5
        g.feed(c)
    return [p for path, p in posted if path.endswith("/readings")], [p for path, p in posted if path.endswith("/alerts")]


def ts(p):
    return p["measured_at"]


def test_gateway_posts_mains_heartbeats_and_switches_in_order(library):
    readings, _ = run_gateway(library, [(500, OFF), (750, KETTLE), (750, OFF)])     # 10 s off, 15 s on, 15 s off
    mains = [p for p in readings if p["device_id"] == "mains"]
    kettle = [p for p in readings if p["device_id"] == "kettle"]
    assert 7 <= len(mains) <= 8 and all(p["provenance"] == "measured" for p in mains)
    assert kettle[0]["apparent_power_va"] == 0.0                                   # start: every device reads 0
    values = [p["apparent_power_va"] for p in sorted(kettle, key=ts)]
    assert values[-1] == 0.0 and max(values) > 1900                                 # on, then off again
    changes = [i for i in range(1, len(values)) if (values[i] > 0) != (values[i - 1] > 0)]
    assert len(changes) == 2                                                        # one on, one off, never flickering
    times = [ts(p) for p in kettle]
    assert times == sorted(times) and len(set(times)) == len(times)                 # posted in time order, no repeats
    assert all(p["inference"]["parent_device_id"] == "mains" for p in kettle)
    assert {p["device_id"] for p in readings} == {"mains", "kettle", "fridge"}


def test_no_device_heartbeat_falls_inside_a_capture(library):
    readings, _ = run_gateway(library, [(500, OFF), (750, KETTLE), (750, OFF)])
    kettle = sorted((p for p in readings if p["device_id"] == "kettle"), key=ts)
    on_at = next(p for p in kettle if p["apparent_power_va"] > 0)
    just_before = kettle[kettle.index(on_at) - 1]
    assert just_before["apparent_power_va"] == 0.0
    gap = (gw.datetime.fromisoformat(ts(on_at).replace("Z", "+00:00"))
           - gw.datetime.fromisoformat(ts(just_before).replace("Z", "+00:00"))).total_seconds()
    assert gap == pytest.approx(0.001)


class FakePipe:
    """Just enough of a Pipeline to hold a capture open."""

    def __init__(self, library):
        self.library, self.house, self.events, self.flags, self.capturing = library, House(), [], [], False

    def feed(self, c):
        return []


def test_pause_never_lasts_more_than_25_seconds(library):
    posted, now = [], {"t": 0}
    pipe = FakePipe(library)
    g = Gateway(pipe, Outbox(lambda p, b: posted.append(json.loads(b)) or 200, lambda: now["t"]), Clock(lambda: now["t"]))
    for c in cycles_from([(50 * 40, OFF)]):      # 40 s
        now["t"] = c.t_ms + 5
        pipe.capturing = c.t_ms >= 1000            # a capture that never ends
        g.feed(c)
    beats = sorted(gw.datetime.fromisoformat(ts(p).replace("Z", "+00:00")).timestamp()
                   for p in posted if p.get("device_id") == "kettle")
    assert max(b - a for a, b in zip(beats, beats[1:])) <= 26.1      # capture began at 1 s, cap 25 s


def test_alerts_are_structured(library):
    posted, now = [], {"t": 0}
    pipe = FakePipe(library)
    g = Gateway(pipe, Outbox(lambda p, b: posted.append((p, json.loads(b))) or 200, lambda: now["t"]), Clock(lambda: now["t"]))
    pipe.flags.append({"kind": "fault", "t_ms": 0, "device": "fridge", "value": "settle_ms", "amount": 412.0})
    pipe.flags.append({"kind": "missed_event", "t_ms": 0, "device": None, "value": None, "amount": -1000.0})
    for c in cycles_from([(5, OFF)]):
        now["t"] = c.t_ms + 5
        g.feed(c)
    alerts = [b for p, b in posted if p == "/api/v1/alerts"]
    assert [a["kind"] for a in alerts] == ["fault", "missed_event"]
    assert alerts[0]["device_id"] == "fridge" and alerts[0]["value"] == "settle_ms" and alerts[1]["device_id"] is None
    assert not any("text" in a for a in alerts)


# connect

def fake_backend(monkeypatch, gateway_status=201, existing=()):
    calls = []

    def request(api, method, path, token, body=None, timeout=10):
        calls.append((method, path, json.loads(body) if body else None))
        if path == "/api/v1/gateways":
            return gateway_status, {"token": "secret"}
        if path == "/api/v1/gateway/config":
            return 200, {}
        if path == "/api/v1/snapshot":
            return 200, {"devices": [{"id": i} for i in existing]}
        return 201, {}
    monkeypatch.setattr(gw, "request", request)
    return calls


def test_connect_registers_once_and_only_adds_new_devices(monkeypatch, tmp_path, library):
    calls = fake_backend(monkeypatch)
    key = tmp_path / "nilm-gateway.key"
    assert connect("http://x", "owner", key, library) == ["mains", "fridge", "kettle"]
    assert key.read_text() == "secret"
    kettle = next(b for m, p, b in calls if p == "/api/v1/devices" and b["id"] == "kettle")
    assert kettle["measurement_kind"] == "inferred" and kettle["parent_device_id"] == "mains"
    assert kettle["kind"] == "kettle" and kettle["room"] == "Kitchen" and kettle["expected_interval_s"] == 10
    fake_backend(monkeypatch, existing=("mains", "kettle"))
    assert connect("http://x", "owner", key, library) == ["fridge"]


def test_connect_explains_a_lost_key(monkeypatch, tmp_path, library):
    fake_backend(monkeypatch, gateway_status=409)
    with pytest.raises(SystemExit, match="Gateway key lost"):
        connect("http://x", "owner", tmp_path / "k.key", library)


def test_connect_refuses_id_collisions(monkeypatch, tmp_path, library):
    fake_backend(monkeypatch)
    clash = Library(library.devices + [teach("Kettle!", KETTLE)])
    with pytest.raises(SystemExit, match="share the id 'kettle'"):
        connect("http://x", "owner", tmp_path / "k.key", clash)


def test_teach_room_is_any_name_the_user_built():
    assert TeachSession("kettle", S, room="  Bedroom 2 ").room == "Bedroom 2"
    for bad in ("", "   ", "x" * 17):
        with pytest.raises(ValueError, match="1 to 16 characters"):
            TeachSession("kettle", S, room=bad)


def test_faults_survive_a_restart(tmp_path):
    from shp.faults import FaultMonitor, Row
    fm = FaultMonitor(S)
    fm.rows.append(Row(1, "fridge", False, 0.01, 2.0, 400, 1.0, 230, 0.9))
    fm.raised.add(("fridge", "settle_ms", 1))
    fm.save(tmp_path / "faults.json")
    back = FaultMonitor.load(S, tmp_path / "faults.json")
    assert back.rows == fm.rows and back.raised == fm.raised


def test_kind_and_room_are_saved_in_the_library(tmp_path, library):
    library.save(tmp_path / "library.json")
    back = Library.load(tmp_path / "library.json")
    assert {(d.name, d.kind, d.room) for d in back.devices} == {("kettle", "kettle", "Kitchen"), ("fridge", "fridge", "Kitchen")}


def test_no_kettle_reading_is_stamped_between_its_step_and_the_event(library):
    readings, _ = run_gateway(library, [(500, OFF), (750, KETTLE), (750, OFF)])
    kettle = [p for p in readings if p["device_id"] == "kettle"]            # in posting order
    for i, p in enumerate(kettle):
        if i and p["measured_at"] < kettle[i - 1]["measured_at"]:
            raise AssertionError("a reading was posted with an earlier time than one before it")
    steps = [p for p in kettle if p["inference"]["confidence"] is not None and p["apparent_power_va"] > 0]
    first_on = min(ts(p) for p in steps)
    stale_on = [p for p in kettle if ts(p) > first_on and p["apparent_power_va"] == 0.0
                and ts(p) < max(ts(q) for q in kettle if q["apparent_power_va"] > 0)]
    assert stale_on == []                                                     # never "off" while it is on


def test_mains_is_a_reserved_name(monkeypatch, tmp_path, library):
    fake_backend(monkeypatch)
    with pytest.raises(SystemExit, match="cannot be called 'mains'"):
        connect("http://x", "owner", tmp_path / "k.key", Library(library.devices + [teach("Mains", KETTLE)]))


def test_replay_is_paced_and_marked(monkeypatch, library, tmp_path):
    from helpers import cycles_from
    posted, clock = [], {"t": 1_000_000}
    monkeypatch.setattr(gw.time, "sleep", lambda s: clock.__setitem__("t", clock["t"] + int(s * 1000) + 1))
    monkeypatch.setattr(gw, "request", lambda api, m, path, tok, body=None, timeout=3: (posted.append((clock["t"], json.loads(body))) or (200, {})))
    lines = ["s,%d,%d,%s" % (c.t_ms, c.n, ",".join(f"{r:.4f}" for r in c.readings)) for c in cycles_from([(500, OFF)])]
    pipe = Pipeline(S, library, NearestModel(), now_ms=lambda: clock["t"])
    gw.run(lines, pipe, "http://x", "tok", replay=True, save=lambda: None, now_ms=lambda: clock["t"])
    assert clock["t"] - 1_000_000 >= 500 * 20 - 50                           # 10 s of board time took ~10 s
    assert all(p["boot_id"].startswith("replay-") for _, p in posted if "boot_id" in p)
    assert all(gw.datetime.fromisoformat(p["measured_at"].replace("Z", "+00:00")).timestamp() * 1000 <= t
               for t, p in posted if "measured_at" in p)                    # never stamped in the future


def test_health_summaries_are_posted(library):
    posted, now = [], {"t": 0}
    pipe = FakePipe(library)
    pipe.health = [{"label": "fridge", "t_ms": 0, "status": "watch", "samples": 2, "days_outside": 1,
                    "shape_diff": 0.02, "shape_limit": 0.1, "surge_peak": 2.0, "surge_low": 1.5, "surge_high": 2.5,
                    "settle_ms": 400.0, "settle_low": 20.0, "settle_high": 60.0, "p": 0.9}]
    g = Gateway(pipe, Outbox(lambda p, b: posted.append((p, json.loads(b))) or 200, lambda: now["t"]), Clock(lambda: now["t"]))
    for c in cycles_from([(5, OFF)]):
        now["t"] = c.t_ms + 5
        g.feed(c)
    [h] = [b for p, b in posted if p == "/api/v1/health"]
    assert h["device_id"] == "fridge" and h["status"] == "watch" and h["settle_ms"] == 400.0 and "label" not in h


# registration from the app: 3 turns, each sent back with its raw waveform

def register(library, segments, wanted):
    posted, now = [], {"t": 0}
    pipe = Pipeline(S, library, NearestModel(), now_ms=lambda: 0)
    box = Outbox(lambda path, body: posted.append((path, json.loads(body))) or 200, lambda: now["t"])
    saved = []
    g = Gateway(pipe, box, Clock(lambda: now["t"]), save=lambda: saved.append(1), wanted=lambda: wanted["now"])
    for c in cycles_from(segments, seed=4):
        now["t"] = c.t_ms + 5
        g.feed(c)
    return g, pipe, posted, saved


HEATER = wave(4.0)
REG = {"id": "ab12", "status": "waiting", "name": "Heater", "setting": None, "kind": "heater", "room": "Bedroom"}


def test_gateway_runs_a_registration_and_adds_the_device(library):
    lib = Library(list(library.devices))
    g, pipe, posted, saved = register(lib, [(30, OFF)] + [(120, HEATER), (60, OFF)] * 5 + [(300, OFF)], {"now": REG})
    turns = [p for path, p in posted if path == "/api/v1/gateway/registrations/ab12/turns"]
    status = [p for path, p in posted if path == "/api/v1/gateway/registrations/ab12/status"]
    assert [p["status"] for p in status] == ["running", "done"] and status[-1]["device_id"] == "heater"
    assert [t["status"] for t in turns][:6] == ["waiting", "kept"] * 3
    kept = [t for t in turns if t["status"] == "kept"]
    assert [t["number"] for t in kept] == [1, 2, 3]
    assert all(len(t["waveform"]["on"]["before"]) == 10 and t["waveform"]["readings_per_cycle"] == 17 for t in kept)
    assert all(t["on_step_va"] > 900 and t["off_step_va"] < -900 and len(t["shape"]) == 50 for t in kept)
    assert len(json.dumps(kept[0]).encode()) < 1 << 20                 # fits the backend's body limit
    entry = lib.get("Heater")
    assert entry is not None and len(entry.on_examples) == 3 and entry.room == "Bedroom" and saved
    assert "heater" in g.channels and pipe.teach is None
    # while registering, the heater was never classified or posted as another device
    assert not [p for path, p in posted if path.endswith("/readings") and p["device_id"] in ("kettle", "fridge")
                and p["apparent_power_va"] > 0]


def test_cancelling_in_the_app_stops_the_registration(library):
    wanted = {"now": REG}
    lib = Library(list(library.devices))
    g, pipe, posted, _ = register(lib, [(30, OFF), (120, HEATER), (60, OFF)], wanted)
    assert pipe.teach is not None and g.registration == "ab12"
    wanted["now"] = None
    g.feed(cycles_from([(1, OFF)], start=10_000)[0])
    assert pipe.teach is None and g.registration is None and lib.get("Heater") is None


def test_a_bad_room_fails_the_registration(library):
    g, pipe, posted, _ = register(Library(), [(5, OFF)], {"now": {**REG, "room": "x" * 30}})
    status = [p for path, p in posted if path.endswith("/status")]
    assert status[0]["status"] == "failed" and pipe.teach is None


def test_registration_sends_live_current_and_switch_times(library):
    lib = Library(list(library.devices))
    g, pipe, posted, _ = register(lib, [(30, OFF)] + [(120, HEATER), (60, OFF)] * 2, {"now": REG})
    live = [p for path, p in posted if path.endswith("/live")]
    assert len(live) == 7                                          # once a second over the 7.8 s stream
    assert all(len(p["amps"]) <= 51 and p["cycle_ms"] == 20 for p in live)
    assert any(p["measuring"] for p in live) and {p["expecting"] for p in live} == {"on", "off"}
    assert max(max(p["amps"]) for p in live) > 3.5                 # the heater's 4 A shows up
    turns = [p for path, p in posted if path.endswith("/turns")]
    on, kept = turns[0], turns[1]
    assert on["status"] == "waiting" and on["direction"] == 1 and on["at"].endswith("Z")
    assert on["before_a"] < 0.1 and abs(on["after_a"] - 4.0) < 0.1
    assert kept["status"] == "kept" and kept["direction"] == -1 and kept["settle_ms"] is not None


def test_registration_starts_with_a_quiet_check_that_sets_the_threshold(library):
    lib = Library(list(library.devices))
    # 4 s off (the quiet check), then one turn
    g, pipe, posted, _ = register(lib, [(200, OFF), (120, HEATER), (60, OFF)], {"now": REG})
    live = [p for path, p in posted if path.endswith("/live")]
    assert live[0]["phase"] == "quiet" and live[-1]["phase"] == "turns"
    assert live[-1]["threshold_a"] >= S.threshold_a                     # never below the saved floor
    assert live[-1]["quiet_a"] is not None and live[-1]["quiet_a"] < 0.05
    turns = [p for path, p in posted if path.endswith("/turns")]
    assert [t["status"] for t in turns] == ["waiting", "kept"]


def test_an_appliance_left_on_restarts_the_quiet_check(library):
    lib = Library(list(library.devices))
    # the heater is on when registration starts; switching it off is the start, then the quiet check runs again
    g, pipe, posted, _ = register(lib, [(120, HEATER), (200, OFF)], {"now": REG})
    turns = [p for path, p in posted if path.endswith("/turns")]
    assert turns[0]["status"] == "ignored"
    live = [p for path, p in posted if path.endswith("/live")]
    assert live[0]["phase"] == "quiet" and live[-1]["phase"] == "turns"
    assert live[-1]["quiet_a"] < 0.05                                   # measured with the heater off, not on
    assert live[-1]["expecting"] == "on" and pipe.detector.threshold >= S.threshold_a
