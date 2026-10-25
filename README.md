# Apeiron — backend-connected energy base

The existing staged React/Three.js interface now reads from an authenticated local API and persistent SQLite database. A separate simulator sends timestamped readings through the same ingestion contract as future hardware. Calculations are deterministic code. No AI or NILM model is implemented.

## Start locally

Requires **Node.js 24.12+** (tested with 26.3.1) and npm.

```bash
npm ci
npm run dev
```

Open **http://127.0.0.1:5182/**. The command starts:

- API on 127.0.0.1:5183
- Independent simulator with real elapsed-time readings
- Vite frontend on 127.0.0.1:5182

Use `APEIRON_UI_PORT=5184 npm run dev` if an existing demo occupies 5182. Stop with Ctrl+C. Existing records remain in `.data/apeiron.sqlite`. The simulator is seeded only if the database has no devices. Its battery and source values are clearly labelled fixtures. It does not fabricate five minutes of energy every two seconds.

The local development proxy injects an owner credential server-side. This is **not a production authentication/deployment setup**. Do not expose the Vite proxy to a LAN or the internet. The existing Vercel static deployment is not changed by these files.

## What to try

1. Open **Data & setup** to inspect all channels, provenance and freshness.
2. Select an appliance in the house. Observe its timestamp and measurement basis under monitor details.
3. Open **Simulator** and pause it. After 15 seconds, the default channels become stale and power displays unavailable, not zero. Resume and readings recover.
4. Turn a simulator load on/off. Its observed state follows a new API reading, not an optimistic frontend number.
5. Open **Understand usage** for a current ranking, known energy from the last 24 hours and stored time-series data.
6. Open **Backup plan**, select essentials and a target duration, then calculate. Unknown/stale battery or selected-appliance readings prevent a reliable estimate. Budget intent is accepted but explicitly not evaluated.
7. Reload the browser or restart the server. Registered devices and reading history persist.

Physical channels are monitor-only. Buttons never switch real appliances. The simulator can change its own synthetic loads through an explicitly labelled action.

## Develop without the simulator

```bash
npm run server
# In another terminal:
npm run dev:ui
```

On a new database, this starts with no devices/readings and unknown battery capacity and source values. Register a gateway and channels using Data & setup or the documented API. Existing simulator installations can disable simulator input and retire conflicting channels without deleting their stored history. The simulator script must be running to generate data; the backend and UI never generate telemetry themselves.

The owner token is generated in `.data/owner.key` (0600). Gateway tokens are returned once at registration, stored hashed, and scoped to their devices. Do not commit, upload or distribute `.data` or its credentials.

## API

| Route | Purpose |
|---|---|
| GET `/api/health` | Public local health check |
| POST `/api/v1/gateways` | Owner registers a gateway; returns one-time token |
| POST `/api/v1/devices` | Owner registers a channel |
| POST `/api/v1/readings` | Gateway-authenticated telemetry ingestion |
| GET `/api/v1/gateway/config` | Gateway reads its own channel configuration |
| GET `/api/v1/snapshot` | Owner reads readings and deterministic calculations |
| GET `/api/v1/history?device_id=mains` | Latest 180 stored readings |
| PUT `/api/v1/settings` | Explicit battery profile and current-rate assumptions |
| PATCH `/api/v1/devices/:id` | Change essential-load preference |
| DELETE `/api/v1/devices/:id` | Retire a channel; history is retained |
| POST `/api/v1/plans/preview` | Advisory target-duration calculation; no commands |
| PATCH `/api/v1/simulation` | Configure simulator input; cannot control hardware |
| GET `/api/v1/insights/context` | Evidence contract for future AI; recommendations empty |

See [hardware contract](docs/HARDWARE-CONTRACT.md) for JSON examples, energy units and timestamp/retry semantics. See [architecture](docs/ARCHITECTURE.md) for assumptions and boundaries.

## Reading and calculation rules

- Reported real watts take priority. Watts can be calculated from voltage, current and true power factor together. Current alone is not converted into assumed real power.
- Energy-only channels can contribute known Wh without pretending to provide instantaneous watts.
- Counter deltas take priority over trapezoidal power integration. Timestamps, resets, restarts, stale readings and gaps are handled explicitly.
- A whole-home aggregate is authoritative. It is never added to child appliance readings or NILM estimates. Without it, the UI labels demand as a monitored-appliance subtotal.
- Actual source and battery readings are separate from appliance consumption. No source/battery values are manufactured for a real installation.
- The cost screen shows known energy at the current configured grid rate, **not a utility bill or mixed-source accounting**.
- Backup estimates use battery charge and the configured capacity/reserve/efficiency/power limit. They assume steady load and no solar. There is no learned load forecast or budget optimizer.
- Future inferred appliance readings include their parent and model version, with optional confidence. They are labelled estimates and excluded from reliable backup planning. No NILM model is supplied.
- No AI recommendation or insight provider is implemented. A future provider consumes validated context; numeric calculations stay in code and physical command execution stays separate.

## Tests and build

```bash
npm test
npm run build
```

The test suite covers current-only inputs, true-power calculation, integration/counters, resets/reboots, idempotent retries, out-of-order frames, strict validation, gateway scoping, real zero versus unknown/stale, aggregate double-count prevention, persistence, advisory planning, mixed provenance, disabled AI/control and a real independent simulator process talking to the HTTP API. The old demo test file is archived in `docs/archive/` and is not an executable acceptance suite for this base.

The pinned Vite tooling was updated to remove inherited audit findings; npm audit reported zero known vulnerabilities at implementation time. The Three.js production bundle is still large; performance work remains before a broad production rollout.

## What is still unbuilt

Actual meter electronics/drivers, waveform collection, MQTT/Modbus adapters, NILM inference, relay switching, calibrated accuracy, real battery characterization, generator fuel modelling, forecasting, AI recommendations, multi-home tenancy, production user login/session management, token rotation/revocation, operational rate limiting, database retention/backups, and remote deployment. These are explicit boundaries, not claimed capabilities.
