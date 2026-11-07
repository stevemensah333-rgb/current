"""The gateway: runs the pipeline on the board's stream and posts what it finds to the app's backend.

  mains                 every 5 s: current_a and apparent_power_va (230 V x current)
  each taught device    every 5 s, on or off: apparent_power_va = sum of step_va of its on-list entries
  a switch              "just before" reading at t - 1 ms, then the new value at the step time t
  alerts                fault, missed_event, unexplained_off, as structured fields
  health                after each usable switch-on: that device's values against its normal ranges

While a step is being captured, device heartbeats pause (at most 25 s), so a later "still on" heartbeat can never
hide a switch-off. Mains keeps posting. See docs/NILM-INTEGRATION.md in the app repo.
"""
import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from shp.library import Library, base_name
from shp.settings import MAINS_V

POST_EVERY_MS = 5000
LIVE_EVERY_MS = 1000        # registration: live current for the app's chart
QUIET_MS = 2000             # registration starts with 2 s of the appliance off: the quiet line sets the threshold
QUIET_MULT = 5              # a switch must stand out 5x the quiet line's flicker, as in calibrate
MAX_PAUSE_MS = 25000
QUEUE_MS = 10 * 60 * 1000
RETRY_MS = 3000             # after a failure, wait 3 s before trying the backend again
DRIFT_CHECK_MS = 5 * 60 * 1000
DRIFT_RATE = 0.01            # the clock correction moves at most 10 ms per second
MODEL_VERSION = "shp-0.1 timee-ts-0.1.1 VA@230V"
GATEWAY_ID = "nilm"


def channel_id(label: str) -> str:
    """'Kitchen Kettle' -> 'kitchen-kettle'; 'mixer|speed 3' -> 'mixer'."""
    slug = re.sub(r"[^a-z0-9_-]+", "-", base_name(label).lower()).strip("-")
    return (slug or "device")[:48]


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log(msg: str) -> None:
    print(f"[gateway] {msg}", flush=True)


# --- talking to the backend -------------------------------------------------------------------------------

def request(api: str, method: str, path: str, token: str, body: bytes | None = None, timeout: float = 3):
    """Returns (status, parsed JSON or None). Raises OSError when the backend cannot be reached."""
    req = urllib.request.Request(api.rstrip("/") + path, data=body, method=method,
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except ValueError:
            return e.code, None


class Outbox:
    """Messages are serialised once and the same bytes are resent. Only network errors and 5xx are retried;
    a 4xx is logged and dropped, so one bad message never blocks the queue. Messages older than 10 minutes
    are dropped while the backend is down."""

    def __init__(self, send: Callable[[str, bytes], int], now_ms: Callable[[], int]):
        self.send, self.now_ms = send, now_ms
        self.queue: deque[tuple[str, bytes, int]] = deque()
        self.next_try = 0           # flush runs every cycle; after a failure it waits RETRY_MS

    def put(self, path: str, payload: dict) -> None:
        self.queue.append((path, json.dumps(payload, separators=(",", ":")).encode(), self.now_ms()))

    def flush(self) -> None:
        now = self.now_ms()
        if now < self.next_try:
            return
        while self.queue and now - self.queue[0][2] > QUEUE_MS:
            log(f"dropped a message queued for more than 10 minutes: {self.queue.popleft()[1][:80]!r}")
        while self.queue:
            path, body, _ = self.queue[0]
            try:
                status = self.send(path, body)
            except OSError:
                self.next_try = now + RETRY_MS     # backend down: keep the queue, try again later
                return
            if status >= 500:
                self.next_try = now + RETRY_MS
                return
            self.queue.popleft()
            if status >= 400:
                log(f"backend refused a message ({status}): {body[:120]!r}")


class Clock:
    """Wall time for posted readings. The pipeline gives board time + offset. Every 5 minutes the gap to the
    PC clock is measured again and corrected gradually, never in one jump. A time is never later than now,
    and each channel's next time is at least 1 ms after its last one."""

    def __init__(self, now_ms: Callable[[], int]):
        self.now_ms = now_ms
        self.correction = 0.0
        self.target = 0.0
        self.next_check: int | None = None
        self.prev_wall: int | None = None
        self.last: dict[str, int] = {}

    def update(self, wall_ms: int) -> None:
        now = self.now_ms()
        if self.next_check is None or now >= self.next_check:
            self.target = now - wall_ms
            self.next_check = now + DRIFT_CHECK_MS
        if self.prev_wall is not None:
            step = DRIFT_RATE * max(0, wall_ms - self.prev_wall)
            self.correction += max(-step, min(step, self.target - self.correction))
        self.prev_wall = wall_ms

    def stamp(self, wall_ms: int, channel: str) -> int:
        t = min(round(wall_ms + self.correction), self.now_ms())
        t = max(t, self.last.get(channel, t - 1) + 1)
        self.last[channel] = t
        return t


# --- the gateway --------------------------------------------------------------------------------------------

class RegistrationWatch:
    """Asks the backend every 2 s, on its own thread, which registration the app wants running.
    The gateway only reads .wanted, so a slow or stopped backend never holds up the readings.
    While the backend cannot be reached the last answer is kept, so a short outage does not cancel a registration."""

    def __init__(self, fetch: Callable[[], tuple[int, object]], every_s: float = 2.0):
        self.fetch, self.every_s = fetch, every_s
        self.wanted: dict | None = None

    def check(self) -> None:
        try:
            status, body = self.fetch()
        except Exception:   # backend down or an odd answer: keep the last one; the thread must never die
            return
        if status == 200 and isinstance(body, dict):
            self.wanted = body.get("registration")

    def start(self) -> "RegistrationWatch":
        import threading

        def loop():
            while True:
                self.check()
                time.sleep(self.every_s)
        threading.Thread(target=loop, daemon=True, name="registration-watch").start()
        return self


class Gateway:
    def __init__(self, pipeline, outbox: Outbox, clock: Clock, replay: bool = False,
                 save: Callable[[], None] = lambda: None, wanted: Callable[[], dict | None] = lambda: None):
        self.pipe, self.outbox, self.clock, self.save = pipeline, outbox, clock, save
        self.wanted = wanted
        self.registration: str | None = None   # id of the registration running now
        self.reg_ended: set[str] = set()      # finished here; the app's answer can lag by one poll
        self.reg_messages = 0
        self.live: list[float] = []            # per-cycle current while registering, sent once a second
        self.quiet: list[float] | None = None  # per-cycle current during the quiet check; None once it is done
        self.quiet_start: int | None = None
        self.quiet_level: float | None = None
        self.next_live: int | None = None
        self.boot = ("replay-" if replay else "") + uuid.uuid4().hex[:12]
        self.channels = sorted({channel_id(d.label) for d in pipeline.library.devices})
        self.seq: dict[str, int] = {}
        self.last_va: dict[str, float | None] = {ch: None for ch in self.channels}
        self.last_p: dict[str, float | None] = {ch: None for ch in self.channels}
        self.mains_amps: list[float] = []
        self.next_mains: int | None = None
        self.next_beat: int | None = None
        self.pause_since: int | None = None
        self.alerts = 0

    # what each channel should read now
    def channel_state(self) -> dict[str, tuple[float, float | None]]:
        state = {ch: (0.0, None) for ch in self.channels}
        for e in self.pipe.house.on_list:
            ch = channel_id(e.label)
            if ch in state:
                va, p = state[ch]
                state[ch] = (va + e.step_va, max(p or 0.0, e.p))
        return state

    def _post_device(self, ch: str, va: float, p: float | None, wall_ms: int) -> None:
        self.seq[ch] = self.seq.get(ch, 0) + 1
        self.outbox.put("/api/v1/readings", {
            "schema_version": 1, "message_id": f"{self.boot}-{ch}-{self.seq[ch]}", "device_id": ch,
            "boot_id": self.boot, "sequence": self.seq[ch], "measured_at": iso(self.clock.stamp(wall_ms, ch)),
            "apparent_power_va": round(va, 1), "provenance": "inferred",
            "inference": {"parent_device_id": "mains", "model_version": MODEL_VERSION,
                          "confidence": None if p is None else round(min(1.0, max(0.0, p)), 3)}})
        self.last_va[ch], self.last_p[ch] = va, p

    def _post_mains(self, wall_ms: int) -> None:
        amps = sum(self.mains_amps) / len(self.mains_amps)
        self.mains_amps.clear()
        self.seq["mains"] = self.seq.get("mains", 0) + 1
        self.outbox.put("/api/v1/readings", {
            "schema_version": 1, "message_id": f"{self.boot}-mains-{self.seq['mains']}", "device_id": "mains",
            "boot_id": self.boot, "sequence": self.seq["mains"], "measured_at": iso(self.clock.stamp(wall_ms, "mains")),
            "current_a": round(amps, 4), "apparent_power_va": round(MAINS_V * amps, 1), "provenance": "measured"})

    def _post_alert(self, flag: dict) -> None:
        self.alerts += 1
        device = channel_id(flag["device"]) if flag["device"] else None
        self.outbox.put("/api/v1/alerts", {
            "schema_version": 1, "message_id": f"{self.boot}-alert-{self.alerts}",
            "raised_at": iso(self.clock.stamp(self.pipe.house.to_wall(flag["t_ms"]), "alerts")),
            "kind": flag["kind"], "device_id": device if device in self.channels else None,
            "value": flag["value"], "amount": None if flag["amount"] is None else round(flag["amount"], 3)})

    def _post_health(self, h: dict) -> None:
        ch = channel_id(h["label"])
        if ch not in self.channels:
            return
        self.alerts += 1
        r = lambda v: round(v, 4)   # noqa: E731
        self.outbox.put("/api/v1/health", {
            "schema_version": 1, "message_id": f"{self.boot}-health-{self.alerts}", "device_id": ch,
            "checked_at": iso(self.clock.stamp(self.pipe.house.to_wall(h["t_ms"]), "health")),
            "status": h["status"], "samples": h["samples"], "days_outside": h["days_outside"],
            **{k: r(h[k]) for k in ("shape_diff", "shape_limit", "surge_peak", "surge_low", "surge_high",
                                  "settle_ms", "settle_low", "settle_high", "p")}})

    # --- registration -------------------------------------------------------------------------------------

    def _reg_post(self, kind: str, payload: dict) -> None:
        self.reg_messages += 1
        self.outbox.put(f"/api/v1/gateway/registrations/{self.registration}/{kind}",
                        {"schema_version": 1, "message_id": f"{self.boot}-reg-{self.reg_messages}", **payload})

    def _reg_stop(self, status: str, message: str, **extra) -> None:
        self._reg_post("status", {"status": status, "message": message, **extra})
        log(f"registration {status}: {message}")
        self.reg_ended.add(self.registration)
        self.pipe.teach, self.registration = None, None
        self._end_quiet()

    def _follow_registration(self) -> None:
        """Start, cancel or finish a registration as the app asks, and send every turn back."""
        from shp.library import TeachSession
        wanted = self.wanted()
        if self.registration and (not wanted or wanted.get("id") != self.registration):
            log("registration cancelled in the app")
            self.reg_ended.add(self.registration)
            self.pipe.teach, self.registration = None, None
            self.pipe.teach_turns = []
            self._end_quiet()
        if (wanted and self.registration is None and wanted.get("status") in ("waiting", "running")
                and wanted.get("id") not in self.reg_ended):
            self.registration = wanted["id"]
            try:
                self.pipe.teach = TeachSession(wanted["name"], self.pipe.s, wanted.get("setting"),
                                               kind=wanted.get("kind") or "generic", room=wanted.get("room") or "Living room")
            except ValueError as e:
                self._reg_stop("failed", str(e))
                return
            self.pipe.teach_turns = []
            self._reg_post("status", {"status": "running", "message": f"listening for {self.pipe.teach.target} turns"})
            self._start_quiet()
            log(f"registering '{wanted['name']}'")

        turns, self.pipe.teach_turns = getattr(self.pipe, "teach_turns", []), []
        session = getattr(self.pipe, "teach", None)
        if session is None or self.registration is None:
            return
        r3 = lambda v: None if v is None else round(v, 3)   # noqa: E731
        for t in turns:
            if t.status == "ignored" and session.pending is not None:
                continue              # the appliance's own wobble during a turn: nothing for the user to see
            if t.status == "ignored" and t.direction < 0:
                self._start_quiet()   # it was still on: the switch-off is the start; measure the quiet line again
            self._reg_post("turns", {
                "status": t.status, "number": t.number, "message": t.message,
                "at": None if t.t_ms is None else iso(self.pipe.house.to_wall(t.t_ms)),
                "direction": t.direction, "before_a": r3(t.before_a), "after_a": r3(t.after_a),
                "on_step_va": None if t.on is None else round(t.on.step_va, 1),
                "off_step_va": None if t.off is None else round(t.off.step_va, 1),
                "settle_ms": None if t.on is None else t.on.settle_ms,
                "surge_peak": None if t.on is None or not t.on.surge else round(max(t.on.surge), 3),
                "shape": None if t.on is None or not t.on.steady else [round(v, 4) for v in t.on.steady],
                "waveform": t.waveform})
        if session.ready:
            entry = session.finish()
            self.pipe.library.add_device(entry)
            self.save()
            ch = channel_id(entry.label)
            if ch not in self.channels:
                self.channels = sorted(self.channels + [ch])
                self.last_va.setdefault(ch, None)
                self.last_p.setdefault(ch, None)
            self._reg_stop("done", f"saved with {len(session.turns)} turns", device_id=ch)
        elif session.varies:
            self._reg_stop("failed", "this device varied a lot between turns; nothing was saved")

    # --- the quiet check: the appliance is off, so whatever flickers on the line now is noise ---------------

    def _start_quiet(self) -> None:
        self.quiet, self.quiet_start = [], None

    def _end_quiet(self) -> None:
        """Back to the saved threshold once the registration ends."""
        self.quiet = self.quiet_start = self.quiet_level = None
        if hasattr(self.pipe, "detector"):
            self.pipe.detector.threshold = self.pipe.s.live_threshold_a

    def _quiet_cycle(self, c, wall_ms: int) -> None:
        """3 s with nothing switching. Example: the line flickers 0.004 A -> 5 x 0.004 = 0.02 A, below the saved
        0.03 A floor, so the floor stays; a noisier line raises the threshold for this registration."""
        if self.pipe.capturing:            # something switched: start the 3 s again
            self.quiet, self.quiet_start = [], None
            return
        if self.quiet_start is None:
            self.quiet_start = wall_ms
        self.quiet.append(c.current_a)
        if wall_ms - self.quiet_start < QUIET_MS or len(self.quiet) < 50:
            return
        import statistics
        self.quiet_level = statistics.fmean(self.quiet)
        threshold = max(self.pipe.s.threshold_a, QUIET_MULT * statistics.pstdev(self.quiet))
        self.pipe.detector.threshold = threshold
        log(f"quiet check: line at {self.quiet_level:.3f} A, switches over {threshold:.3f} A ({MAINS_V * threshold:.0f} W) count")
        self.quiet = None

    def _send_live(self, c, wall_ms: int) -> None:
        """While registering: the current of every cycle, once a second, plus what the monitor is doing now.
        measuring = a switch was seen and is being measured; expecting = the switch the user should make next."""
        session = getattr(self.pipe, "teach", None)
        if session is None or self.registration is None:
            self.live, self.next_live = [], None
            return
        if self.quiet is not None:
            self._quiet_cycle(c, wall_ms)
        self.live.append(round(c.current_a, 3))
        if self.next_live is None:
            self.next_live = wall_ms + LIVE_EVERY_MS
        if wall_ms < self.next_live:
            return
        self.outbox.put(f"/api/v1/gateway/registrations/{self.registration}/live", {
            "schema_version": 1, "at": iso(self.clock.stamp(wall_ms, "live")), "cycle_ms": 20, "amps": self.live,
            "measuring": bool(self.pipe.capturing), "expecting": "off" if session.pending else "on",
            "kept": len(session.turns), "phase": "quiet" if self.quiet is not None else "turns",
            "quiet_a": None if self.quiet_level is None else round(self.quiet_level, 4),
            "threshold_a": round(self.pipe.detector.threshold, 4)})
        self.live, self.next_live = [], wall_ms + LIVE_EVERY_MS

    def _heartbeat(self, wall_ms: int) -> None:
        for ch, (va, p) in self.channel_state().items():
            self._post_device(ch, va, p, wall_ms)

    def feed(self, c) -> list[str]:
        messages = self.pipe.feed(c)
        wall = self.pipe.house.to_wall(c.t_ms)
        self.clock.update(wall)
        if self.next_beat is None:              # gateway start: every device reads its current state
            self._heartbeat(wall)
            self.next_beat = self.next_mains = wall + POST_EVERY_MS

        self.mains_amps.append(c.current_a)
        if wall >= self.next_mains:
            self._post_mains(wall)
            self.next_mains = wall + POST_EVERY_MS

        events, self.pipe.events = self.pipe.events, []
        for _, sig, _ in events:
            t = self.pipe.house.to_wall(sig.t_ms)
            for ch, (va, p) in self.channel_state().items():
                if va != self.last_va.get(ch):
                    # "just before": the old value with its old confidence, 1 ms before the step
                    self._post_device(ch, self.last_va.get(ch) or 0.0, self.last_p.get(ch), t - 1)
                    self._post_device(ch, va, p, t)
        flags, self.pipe.flags = self.pipe.flags, []
        for f in flags:
            self._post_alert(f)
        health, self.pipe.health = getattr(self.pipe, "health", []), []
        for h in health:
            self._post_health(h)
        if events or flags or health:
            self.save()
        self._follow_registration()
        self._send_live(c, wall)

        if self.pipe.capturing:
            self.pause_since = self.pause_since if self.pause_since is not None else wall
        else:
            self.pause_since = None
        paused = self.pause_since is not None and wall - self.pause_since < MAX_PAUSE_MS
        if wall >= self.next_beat and not paused:
            self._heartbeat(wall)
            self.next_beat = wall + POST_EVERY_MS

        self.outbox.flush()
        return messages


# --- setup ----------------------------------------------------------------------------------------------------

def connect(api: str, owner_token: str, key_file: str | Path, library: Library) -> list[str]:
    """Registers the gateway, mains and one inferred channel per taught device. Safe to run again.
    Returns the channel ids that were added."""
    key_file = Path(key_file)
    devices: dict[str, list] = {}
    for d in library.devices:
        devices.setdefault(channel_id(d.label), []).append(d)
    if "mains" in devices:
        raise SystemExit("A device cannot be called 'mains': that name is the whole-home clamp. Teach it under another name.")
    for ch, ds in devices.items():
        names = {base_name(d.label) for d in ds}
        if len(names) > 1:
            raise SystemExit(f"Two devices would share the id '{ch}': {', '.join(sorted(names))}. Rename one.")

    if key_file.exists():
        status, _ = request(api, "GET", "/api/v1/gateway/config", key_file.read_text().strip())
        if status == 401:
            raise SystemExit(f"The gateway key in {key_file} is not known to this database. "
                             f"Delete {key_file} and run connect again.")
    else:
        status, body = request(api, "POST", "/api/v1/gateways", owner_token,
                               json.dumps({"id": GATEWAY_ID, "name": "NILM pipeline"}).encode())
        if status == 409:
            raise SystemExit("Gateway key lost. Delete the database file (.data/nilm.sqlite) to start a new installation.")
        if status != 201:
            raise SystemExit(f"Could not register the gateway ({status}): {body}")
        key_file.parent.mkdir(parents=True, exist_ok=True)
        key_file.write_text(body["token"])
        os.chmod(key_file, 0o600)

    status, snapshot = request(api, "GET", "/api/v1/snapshot", owner_token)
    if status != 200:
        raise SystemExit(f"Could not read the backend ({status}). Is it running at {api}?")
    existing = {d["id"] for d in snapshot["devices"]}
    added = []
    wanted = [{"id": "mains", "name": "Whole-home clamp", "role": "whole_home", "measurement_kind": "aggregate",
               "expected_interval_s": POST_EVERY_MS // 1000}]
    for ch, ds in sorted(devices.items()):
        first = ds[0]
        wanted.append({"id": ch, "name": base_name(first.label)[:48], "role": "appliance",
                       "measurement_kind": "inferred", "parent_device_id": "mains", "kind": first.kind[:32],
                       "room": first.room, "expected_interval_s": 10})
    for d in wanted:
        if d["id"] in existing:
            continue
        status, body = request(api, "POST", "/api/v1/devices", owner_token,
                               json.dumps({**d, "gateway_id": GATEWAY_ID}).encode())
        if status != 201:
            raise SystemExit(f"Could not register {d['id']} ({status}): {body}")
        added.append(d["id"])
    return added


def run(lines, pipeline, api: str, gateway_token: str, replay: bool, save: Callable[[], None],
        now_ms: Callable[[], int] = lambda: int(time.time() * 1000)) -> None:
    """Feeds every cycle through the gateway. A replay is paced at real time, so its readings land 'now'."""
    from shp.transform import transform
    outbox = Outbox(lambda path, body: request(api, "POST", path, gateway_token, body)[0], now_ms)
    watch = RegistrationWatch(lambda: request(api, "GET", "/api/v1/gateway/registration", gateway_token, timeout=2)).start()
    gw = Gateway(pipeline, outbox, Clock(now_ms), replay=replay, save=save, wanted=lambda: watch.wanted)
    for c in transform(lines):
        if replay:
            while now_ms() < pipeline.house.to_wall(c.t_ms):
                time.sleep(0.005)
        for msg in gw.feed(c):
            print(msg, flush=True)
