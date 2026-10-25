# Hardware ingestion contract v1

This contract leaves the meter electronics undecided. No hardware driver, NILM model or AI provider is implemented. Start with one home and one gateway. The adapter may run on a microcontroller, a hub, or another process; the browser never needs a hardware-specific protocol.

## Measurement meaning

- `current_a`: RMS current in amperes. Current is drawn by loads; it is not a watt reading.
- `voltage_v`: RMS voltage in volts.
- `power_factor`: true power factor from 0 to 1 for this nonnegative load calculation.
- `power_w`: reported active/real power, watts. Takes priority over a calculation. If absent, code calculates watts only when current, voltage AND power factor are present. Current alone remains current; no assumed 230 V or unity power factor is inserted.
- `energy_total_wh`: a cumulative, monotonically increasing counter in watt-hours, **not an interval delta**. For appliances/mains it is consumed energy; solar/generator it is production; grid it is imported energy; battery it is discharged energy. This base does not model export/charging counters. The adapter must not send a net or bidirectional counter under this name.
- `battery_soc_pct`: battery state of charge, 0–100, on a separately registered battery channel. This cannot be inferred from appliance watts.

`power_w` can be negative only on grid (export) or battery (charging) channels. Signed-power intervals without directional counters are kept raw but excluded from the base's consumption/production energy integration. There is no net-metering bill calculation.

Hardware can send power-only, energy-only or current-only readings. There must be at least one measurement. Do not manufacture missing fields. Null fields are supported. Raw high-frequency waveforms are not part of v1; reserve a separate waveform-storage path if the chosen NILM design requires them. Sample rate, features and training data depend on that future design, not on this low-rate dashboard simulator.

## Register and authenticate

API binds to `127.0.0.1:5183`. `npm run server` starts an empty, non-simulating database; `npm run dev` explicitly provisions a simulator installation only on a new database. The owner token is generated once in `.data/owner.key`, mode 0600. Never commit it. With the server running, a local shell can read it:

```bash
OWNER_TOKEN="$(cat .data/owner.key)"
curl -s http://127.0.0.1:5183/api/v1/gateways \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"meter-gateway","name":"First prototype gateway"}'
```

Save the returned `token` privately as `APEIRON_GATEWAY_TOKEN` on the adapter. The API stores its hash and does not return it again. A gateway can ingest only its own registered channels and read its own gateway configuration. It cannot read the household dashboard, register other gateways, change tariffs, or execute commands.

```bash
curl -s http://127.0.0.1:5183/api/v1/devices \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"fridge-meter","name":"Kitchen fridge","gateway_id":"meter-gateway","role":"appliance","measurement_kind":"direct","room":"Kitchen","kind":"fridge","expected_interval_s":5}'
```

Roles: `appliance`, `whole_home`, `solar`, `grid`, `battery`, `generator`. One active whole-home authority and one active channel per source role are supported. Nominal watts are optional metadata and never substituted for actual readings. A whole-home channel should use `measurement_kind:"aggregate"`; appliance submeter channels use `direct`.

## Send a reading

```json
{
  "schema_version": 1,
  "message_id": "fridge-boot19-204",
  "device_id": "fridge-meter",
  "boot_id": "boot19",
  "sequence": 204,
  "measured_at": "2026-10-25T20:00:00Z",
  "power_w": 148.2,
  "energy_total_wh": 82450.3,
  "provenance": "measured"
}
```

POST that JSON to `/api/v1/readings` with `Authorization: Bearer <gateway token>` and `Content-Type: application/json`. Use your actual current UTC measurement timestamp, not the example timestamp. JSON body limit: 64 KiB. `message_id`, `device_id`, `boot_id`, timezone-qualified timestamp and schema version are required. Sequence is optional but, when present, is unique per device boot. Keep the same message ID and payload on retries.

- Repeated identical messages return `duplicate:true` and do not add energy.
- Reusing an ID for changed data, or an existing device timestamp/boot sequence, returns 409.
- Out-of-order readings are accepted within a seven-day backfill window. Energy is recalculated in measurement-time order; late arrivals do not overwrite newer readings.
- Timestamps more than 30 seconds in the future are rejected. Slight future skew is stored but is not treated as current until that measurement time arrives.
- Backend receipt time is separate and retained. Real hardware needs clock synchronization or an adapter with a defined timestamp policy.
- The ingestion channel is strict versioned JSON. Unknown fields or invalid units/types are rejected. A future schema version/adapter can add measurements without rewriting the UI.

## Freshness and energy

Freshness is measured from `measured_at`, not arrival time. A channel becomes stale after max(15 seconds, three expected intervals). A current-only channel can be recent while its watts remain unavailable. No readings are represented as zero just because a connection is lost.

For the latest 24 hours, valid counter differences take priority over power integration. Counter deltas can span reporting gaps within a boot session. Without counters, trapezoidal power integration is limited to intervals up to 30 seconds. Counter resets, boot changes, negative directional-power intervals and unknown power intervals are not invented. Known Wh, covered seconds and unknown interval counts are exposed. The first sample establishes a baseline; its lifetime counter is not presented as 24-hour energy.

A registered whole-home meter is authoritative even when stale. It is never silently replaced by a smaller sum of known appliances. Without one, the app explicitly shows a monitored-appliance subtotal. Inferred loads, direct submeters and aggregate demand are not added together.

## NILM boundary

NILM disaggregates aggregate household measurements into estimates for appliances. It is not a guaranteed ability of a current sensor. No NILM model is built here. If a future model is available, register a channel with `measurement_kind:"inferred"`, role `appliance`, and `parent_device_id` pointing to an aggregate whole-home channel. Send `provenance:"inferred"` with:

```json
"inference": {
  "parent_device_id": "mains",
  "model_version": "your-validated-model-version",
  "confidence": null
}
```

Send estimated `power_w`. A confidence score is optional and is not automatically a calibrated accuracy guarantee. Inferred physical counters and inferred battery state are rejected. These estimates are labelled, excluded from household totals, and do not qualify as reliable inputs to the backup planner. Future allocation and uncertainty models must be validated before changing that policy.

## Transport and deployment boundary

HTTP JSON is the initial adapter interface. An MQTT/serial/Modbus adapter can translate hardware messages into it later; those transports have not been implemented. For an ESP32 or other external device, use a deliberately configured secure gateway deployment; this loopback-only service is not reachable from the LAN by default. Do not merely expose the development Vite proxy publicly. Production needs TLS, user/session authorization, gateway token rotation/revocation, tenancy, operational limits and a deployment with persistent storage. SQLite is for the single-home base; a static Vercel frontend alone cannot host this continuously running API/database/simulator.

Technical references: [OpenEnergyMonitor real versus apparent power](https://openenergymonitor.org/docs/electricity-monitoring/ac-power-theory/advanced-maths.html), [NILM definition and research](https://ojs.aaai.org/index.php/AAAI/article/view/8162).
