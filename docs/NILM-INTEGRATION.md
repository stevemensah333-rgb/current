# NILM pipeline integration

Our pipeline (`pipeline/`, Python) names appliances from one clamp sensor. This document says how it feeds the
app and how the assistant works. Where this document and `HARDWARE-CONTRACT.md` differ, this document wins:
it records our design choices. The pipeline's own design is `pipeline/DESIGN.md`.

## The idea in one worked line

The fridge is on (1.0 A). The kettle switches on.

- Mains: 230 V × 9.1 A = 2093 VA. The app shows "≈ 2.1 kVA (estimated)".
- TimEE names the step "kettle, p = 0.94". The kettle channel gets 2000 VA, marked "estimated, 94 % confident".
- "Not yet named" (`unnamed_va` in the API): 2093 − (2000 + 230) = about 0 VA.

**Why VA and not watts.** We have one current clamp and no voltage sensor, so we know neither the real voltage nor
the power factor. Volts × amps with an assumed 230 V is *apparent* power (VA). Real watts are lower whenever the
power factor is below 1. For example, 968 VA at power factor 0.8 is 774 W, so the VA figure is 25 % high.
Every value the gateway sends is VA, and the app labels it so.

## How the parts connect

```
clamp → ESP32 ──serial──► pipeline gateway (Python)
                               │  POST /api/v1/readings   mains + one channel per taught device
                               │  POST /api/v1/alerts     fault, missed event, unexplained switch-off   ← new
                               ▼
                     app backend (Node, .data/nilm.sqlite) ──► React app
                               │
                               └── assistant job ──► LFM3-1.7B in LM Studio   (toggle: local)
                                                └─► Claude Opus 5.5           (toggle: cloud)
```

## 1 Channels and setup

`pipeline: connect` registers everything once, with the local owner key. It is safe to run again: it only adds
devices taught since.

| Channel id | Role | Kind | Parent | Sends every |
|---|---|---|---|---|
| `mains` | whole_home | aggregate | – | 5 s |
| one per taught device, e.g. `kettle` | appliance | inferred | `mains` | 5 s, on or off |

- **Device id** = the merged device name (`mixer|speed 3` → `mixer`) made safe: lower case, spaces to `-`, only
  letters, digits, `-` and `_`. "Kitchen Kettle" → `kitchen-kettle`. Names are cut to 48 characters. If two
  devices would get the same id, `connect` refuses and names both.
- **kind and room.** `teach --name kettle --kind kettle --room Kitchen` stores them in `library.json`.
  `--room` must be one of the app's rooms: Living room, Kitchen, Bedroom, Office. The house draws `ac`, `fridge`
  and `lights` specially; any other kind uses the generic appliance. Without them: `generic`, `Living room`.
  For devices with settings, the first taught setting's kind and room are used.
- **Gateway key** is stored next to the database: `.data/nilm-gateway.key` (`.data/` is not committed). If the
  database has the gateway but the key file is gone, `connect` stops with: "Gateway key lost. Delete
  `.data/nilm.sqlite` to start a new installation." That avoids a gateway stuck on 401.

## 2 Contract change: `apparent_power_va`

One new optional reading field, `apparent_power_va` (number, 0 or more). It counts as a measurement for the
"at least one measurement" rule. `realPower()` gains one fallback:

```
power_w reported              → basis "reported"
voltage × current × pf        → basis "calculated_from_voltage_current_pf"
apparent_power_va             → basis "apparent_estimate_va"     ← new; only when the two above are missing
nothing                       → unavailable
```

The label follows the value everywhere:

| Place | What changes |
|---|---|
| snapshot | new `demand_basis` (e.g. `apparent_estimate_va`); new `unnamed_va` = mains VA − sum of inferred VA, never below 0, and only when mains and every inferred channel are fresh (otherwise null, shown "Unavailable") |
| energy | basis `integrated_apparent_va`, shown as "VA-hours (estimated)" |
| cost | "VA-hours × grid rate. Overstates the bill: power factor and real voltage are unknown." |
| backup planner, `/insights/context` | the same basis fields, so nothing presents VA as watts |
| UI | a `powerLabel(value, basis)` formatter: "≈ 968 VA (estimated)"; `watts()` only for basis `reported`/`calculated` |

When the voltage sensor arrives, the gateway multiplies voltage and current sample by sample, sends true
`power_w`, and the app shows watts with no other change.

## 3 What the gateway posts

**Mains, every 5 s:** `current_a` (average of the last 5 s) and `apparent_power_va` = 230 × that.

**Each taught device, every 5 s, on or off:** `apparent_power_va` = the sum of `step_va` over on-list entries
with that device id. Two lamps on → 120 VA; one goes off → 60 VA; both off → 0. `provenance: "inferred"`,
`inference: {parent_device_id: "mains", model_version: "shp-0.1 timee-ts-0.1.1 VA@230V", confidence: p}`.
Unknown devices are not posted; they show in `unnamed_va`.

**One kettle switch-on to switch-off, as posted** (the step happens at 12:00:03.4):

```
12:00:00  kettle 0 VA        heartbeat
12:00:03.4 step happens; the detector starts capturing → device heartbeats pause (mains keeps posting every 5 s throughout)
12:00:03.399  kettle 0 VA     "just before" reading, so energy does not ramp in from 12:00:00
12:00:03.4    kettle 2000 VA  the event, stamped at the step time, p 0.94          (sent ~1 s later)
12:00:05  kettle 2000 VA     heartbeats resume
...
12:10:07.2 step down; capture → heartbeats pause
12:10:07.199  kettle 2000 VA  "just before"
12:10:07.2    kettle 0 VA     the event
```

Why the pause: the switch-off is only known after its "after" window. Without the pause, a heartbeat sent in that
window would carry a later time and still say "on", and the app shows the newest reading. Only device channels
pause; mains never does. Inferred channels use `expected_interval_s: 10`, so they are stale only after 30 s.
Several switches in a row could chain captures, so a pause never lasts more than 25 s: at 25 s the gateway posts
the current on-list state anyway.

**Ids and retries.** `boot_id` = new for each gateway start (`replay-…` for a replay). `sequence` counts per device.
`message_id` = `<boot>-<device>-<sequence>`. Each message is serialised once and the same bytes are resent.
Only network errors and 5xx are retried. A 400 or 409 is logged and dropped, so one bad message never blocks the
queue. Up to 10 minutes of messages are queued while the backend is down; older ones are dropped and logged.

**Time.** `measured_at` is the wall time of the cycle:
- **Offset.** At start, wall time minus board time. Board says 10:00:00.000, PC says 10:00:02 → offset +2 s.
- **Drift.** Every 5 minutes the offset is compared again. A difference is corrected gradually, by at most
  10 ms per second, never in one jump. So time never runs backwards.
- **Order.** Each channel's next `measured_at` is at least 1 ms after its last one. Two readings never share a time,
  which the backend would refuse.
- **Replay.** `--in file` uses the live clock too, paced at real time, so readings land "now", inside the backend's
  30 s / 7-day window. Its `boot_id` starts with `replay-`, so replayed data stays recognisable.

**Saved state.** The library is saved after every new working example. Fault rows and raised alerts are saved
to `pipeline/faults.json` after every event. A hard stop (Windows ends child processes without warning) loses
at most the event in progress, and a 3-day fault streak survives restarts.

## 4 Alerts (new route)

`POST /api/v1/alerts`, gateway token (added to the gateway-auth routes beside `/readings`). Body:

```json
{"schema_version": 1, "message_id": "…", "raised_at": "…", "kind": "fault",
 "device_id": "fridge", "value": "settle_ms", "amount": 412}
```

- `kind`: `fault` (fault monitor), `missed_event` (power monitor), `unexplained_off` (house state).
- `device_id` may be null (for `missed_event`). If it is given, it must belong to the posting gateway, or 403,
  as for readings. `value` and `amount` are optional.
- Same rules as readings: unknown fields rejected, 30 s future / 7-day past window, duplicate `message_id` is
  `duplicate: true`, reused id with different data is 409.
- Stored as structured fields in a new `alerts` table. **The app writes the sentence**, for example "Fridge:
  settling time outside its normal range for 3 days (412 ms)". No gateway free text is ever shown or given to a model.
- Snapshot gains `alerts`: the open ones, newest first, at most 10. `POST /api/v1/alerts/<id>/ack` (owner) closes one.
  The app lists open alerts on Your home with a "Dismiss" button.

## 4b Device health (new route, replaces the Backup tab)

After every usable switch-on, the fault monitor compares it with the device's baseline and the gateway posts that
device's latest health: `POST /api/v1/health`, gateway token, one device per message.

| Field | Meaning |
|---|---|
| `status` | `ok` (all in range), `watch` (out of range today), `alert` (out of range `fault_days` days in a row) |
| `shape_diff`, `shape_limit` | how far the wave drifted from its taught shape, and the limit |
| `surge_peak`, `surge_low`, `surge_high` | first-cycle jump as a multiple of the step, and its normal range |
| `settle_ms`, `settle_low`, `settle_high` | time to settle, and its normal range |
| `p`, `samples`, `days_outside`, `checked_at` | name confidence, switch-ons that day, days out of range, when |

The backend keeps only the newest check per device (an older one arriving late is ignored) and the snapshot gains
`health`. The **Device health** tab shows one row per taught device; devices without a check yet say so.
Solar and battery are not part of this installation: their parts are removed from the house and the settings.



**Where it lives.** In the app backend, `server/assistant.mjs`, so it reads the same data the house shows. The
pipeline's Python `control.py` stays for command-line use.

**The toggle.** One new setting, `assistant.provider` (validated in `updateSettings`):

| Setting | Label | Model | Note shown under the toggle |
|---|---|---|---|
| `local` (default) | On this computer | LFM3-1.7B in LM Studio, `http://localhost:8000` | "Private. An answer can take 1–3 minutes." |
| `cloud` | Cloud | Claude Opus 5.5 (`claude-opus-5-5`), official `@anthropic-ai/sdk`, effort `low` | "Faster. Sends your home's readings to Anthropic." |

For cloud, the request also turns on Anthropic's automatic fallback model for declined requests
(`fallbacks: "default"`). If Claude still declines, the panel says "Claude declined to answer this."

- The key is `ANTHROPIC_API_KEY` in `.env`, loaded by the backend with `node --env-file-if-exists=.env`. It never
  reaches the browser. Without it, choosing Cloud shows "Cloud is not set up: add ANTHROPIC_API_KEY to .env".
- If the chosen provider is unreachable, the panel says so. It never switches provider silently.

**It runs as a job, because local answers are slow.**

```
POST   /api/v1/assistant          {"message"}            → {"job_id"}     (409 if a job is already running)
GET    /api/v1/assistant/<id>                             → {"status": running|done|failed|cancelled, "reply"?}
DELETE /api/v1/assistant/<id>                             → cancels it
```

One job at a time, because LM Studio answers one request at a time. The panel polls every 2 s with plain short
requests, so the app's 8 s request timeout and its `busy` lock are not involved. A Cancel button stops the job.
Jobs live in memory: after a backend restart, polling an old job gets 404, and the panel says
"The assistant restarted; ask again." instead of staying on "thinking…".

**What the model sees.** A system prompt plus a state line, together under about 400 tokens, built on the server
from ids, numbers and fixed words only:

```
Values are apparent power in VA, estimated from current at 230 V. p is the pipeline's confidence.
On now: kettle 2000 VA p 0.94; fridge 230 VA p 0.88. Mains 2093 VA. Not yet named 0 VA.
Open alerts: fridge settle_ms high 3 days.
```

Device names in the state line are the safe ids from section 1, so a device name cannot carry instructions.

**Two tools:**

| Tool | What it does |
|---|---|
| `get_usage(device, period)` | `period`: `hour`, `today` (since local midnight), `24h`, `week`. Hours on and VA-hours, from its own query of that channel's stored readings. With less history than the period, it reports the hours actually covered, e.g. "2.1 h on in the 3.5 days recorded". |
| `switch_off(device)` | The device must be on now. Returns "needs the user's confirmation". The server creates a confirm token for that device id: single use, valid 5 minutes, tied to that job. On press, the server checks again that the device is still on. |

There is no `notify_user`: the reply text does that job, and fewer tools suit a 1.7B model.
At most 3 tool rounds for local, 5 for cloud. A local call is capped at 2,048 new tokens (the model card's limit) and 5 minutes; past that the panel says so.

**Switching off.** The reply carries `confirm: {token, device}`. The panel shows "Switch off kettle?" with a button,
which sends only the token. For simulator devices the server uses the existing simulation switch. For gateway
devices it answers "No switch fitted for kettle yet", because the clamp only listens. Physical `/commands` stays 501.

**Adapters.** One per provider, both giving the same `{text, tool_calls}`:
- local: OpenAI-style chat with tools; reads LFM3's raw XML tool calls too, if a server returns them as text.
- cloud: Messages API tool use (`tool_use` / `tool_result` blocks); the full response content is passed back each round.

The snapshot `ai` block becomes `{enabled: true, provider, model}`.

**The panel.** The Ask icon button in the header opens a see-through card that floats over the house and can be dragged
by its top bar. Home details are a second floating card of the same kind (info icon in the house controls), closed
while Ask is open. There is no footer: back, next and the stage dots float as icon buttons at the bottom right.
The Ask card holds the toggle with its note, the conversation, a "thinking…" state with Cancel, and confirm buttons.

## 6 Teaching

Teach mode stays in the command line for now. The serial port can be open in only one program at a time on
Windows, so the order is:

1. Stop `dev:nilm`. If teach then says COM6 is busy, a gateway process is still running:
   `taskkill /IM python.exe /F` ends it.
2. `pipeline: teach --name kettle --kind kettle --room Kitchen --port COM6`
3. Start `dev:nilm` again. It runs `connect` first, which adds the new channel, and the gateway loads the new library.

A teach screen in the app is the next step after this.

## 7 Running it

`npm run dev` stays the simulator demo on `.data/apeiron.sqlite`, unchanged.
`npm run dev:nilm` (new `scripts/dev-nilm.mjs`, never calls the simulator bootstrap) does this, in order:

1. Sets `APEIRON_DB` to the absolute path of `.data/nilm.sqlite` for every child, so the backend and the Vite proxy
   use the same database and owner key. The gateway also gets `APEIRON_API` and `NILM_KEY_FILE` as absolute paths,
   because it runs from `pipeline/`.
2. Starts the backend, with `--env-file-if-exists=.env`, and waits for `/api/health`.
3. Runs `pipeline: connect`.
4. Starts the gateway with the venv's own `python.exe` (not through `uv run`, so stopping it really ends it):
   `NILM_SERIAL=COM6`, or `NILM_REPLAY=<file>` for a recorded session.
5. Starts the app (Vite) on port 5182.

LM Studio (`lms server start`, `lms load lfm3-1.7b`) is started separately, and only needed for the local assistant.

## 8 Testing

- Node (`npm test`): `apparent_power_va` validation and the `realPower` fallback; the basis labels in snapshot,
  energy and cost; alerts routes (auth, duplicates, time window, ack); the assistant jobs (one at a time, cancel,
  poll), both adapters with stand-in models, the confirm token, tool rounds cap, and the provider setting.
- Python (`pipeline/`): the gateway against a stand-in backend: heartbeats, the pause during capture, the
  "just before" readings, ids, exact-bytes retries, 400/409 dropping, the queue limit, clock re-sync, replay pacing;
  `connect` ids and collisions; kind/room in the library; `faults.json` and library saving.
- End to end: replay a recorded session through `dev:nilm`; check the house shows the devices and the VA labels.
