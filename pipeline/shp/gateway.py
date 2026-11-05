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

class Gateway:
    def __init__(self, pipeline, outbox: Outbox, clock: Clock, replay: bool = False,
                 save: Callable[[], None] = lambda: None):
        self.pipe, self.outbox, self.clock, self.save = pipeline, outbox, clock, save
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
    gw = Gateway(pipeline, outbox, Clock(now_ms), replay=replay, save=save)
    for c in transform(lines):
        if replay:
            while now_ms() < pipeline.house.to_wall(c.t_ms):
                time.sleep(0.005)
        for msg in gw.feed(c):
            print(msg, flush=True)
