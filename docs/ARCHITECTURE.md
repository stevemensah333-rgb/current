# Apeiron base implementation

## Data path

```
Independent simulator OR future hardware adapter
    -> authenticated POST /api/v1/readings
    -> validation and immutable SQLite raw readings
    -> deterministic timestamp-based calculations
    -> snapshot / history / plan preview API
    -> React + Zustand + existing Three.js house

Future recommendations provider
    <- GET /api/v1/insights/context (evidence, constraints, no recommendations)
```

The browser no longer generates power or integrates energy. It polls the API every two seconds. Simulation is a separate process sending the exact same schema and authenticated route as hardware. It uses real elapsed time, not five invented minutes per frame. Simulator control requests change only its desired input states; the UI's measured state changes after the next reading arrives. Simulator data always says `simulated`.

The base is intentionally local and single-home. It is not claimed as a production hosted platform or a tested meter implementation. Existing 3D/stage design is retained. Source data, missing-data labels and calculations replace simulated frontend state.

## Modules

- `shared/calculations.ts`: pure power, energy, cost-at-rate and backup equations. Runtime shared by backend and tests.
- `server/validation.mjs`: versioned strict input contract.
- `server/database.mjs`: SQLite schema, credential hashing and restricted local credential files.
- `server/service.mjs`: scoped registration, ingestion, timestamp ordering, summaries and planner evidence.
- `server/index.mjs`: native Node HTTP API, authentication and loopback binding.
- `scripts/bootstrap.mjs`: explicit simulator installation on a fresh DB; never seeds real installations implicitly.
- `scripts/simulator.mjs`: separate HTTP producer; fault options for duplicate, late, invalid and dropout scenarios.
- `src/telemetry.ts`, `src/store.ts`: typed API boundary and backend-backed state.
- `src/BaseScreens.tsx`: data setup, recorded usage and deterministic advisory backup preview.
- `tests/base.test.mjs`: unit, storage, HTTP auth and independent simulator-process integration tests.

Historical demo functions remain in `src/energy.ts` as an archived fixture helper used to seed simulator metadata. The active frontend no longer calls its fake ticks or uses its dispatch policy to invent source readings, cost or runtime.

## Calculation scope

Real watts are either reported or computed from voltage, current and true power factor. Energy-counter differences take priority over integration, using actual timestamps. Calculations disclose gaps, resets, boot changes and covered seconds. Costs shown are energy multiplied by the currently configured grid price: an explicitly labelled grid-rate equivalent, not a historical tariff ledger, generator fuel calculation or mixed-source bill. Battery-only estimates use independently reported charge and explicitly configured capacity, reserve, efficiency and discharge-power limit. They assume steady loads and no solar contribution. Inferred or stale selected loads, unknown battery data and mixed simulated/measured inputs make planning incomplete. Budgets are accepted as intent but returned `not_evaluated`; no unsupported savings/optimization claim is made.

## Future AI boundary

No SDK, model, prompt, API key or AI recommendation logic is implemented. `/api/v1/insights/context` returns evidence with reading IDs, timestamps, provenance, constraints and an empty recommendation list. A future provider can consume this versioned context to explain or propose actions. It must call deterministic calculations for numeric claims. Physical `/commands` routes return 501. There is no relay implementation and no implicit actuation from recommendations. NILM is a different, optional inference pipeline with its own data-quality and validation requirements; its input contract is ready, but its model is not implemented.

## Data quality and failure behavior

A whole-home authority is distinct from child meters and inferred loads. Double counting is prevented. Unavailable real-power fields remain null in API data. The legacy scene adapter keeps a numeric last-known value internally only for drawing furniture, guarded by online/data-quality flags. House total and source labels use nullable API values; unavailable is not rendered as a real zero. Backend connection failure marks all appliance values non-current and shows an alert; there is no frontend simulation fallback.

Device retirement is soft; readings are retained. History persists across backend/browser restarts. The 24-hour calculation window does not imply 24 hours of measured coverage. The raw database has no automatic retention/backup/restore policy yet. Keep the `.data` folder when moving an installation and secure its credentials. Do not distribute it with the source ZIP.

## Local authentication

The API requires an owner bearer token for dashboard, configuration and planning requests. Gateways have distinct hashed tokens restricted to registered devices and gateway configuration. Ingestion does not accept the owner token. Vite's loopback-only development proxy injects the owner token server-side from `.data/owner.key`, never into the browser bundle. This convenience is development-only; do not expose the proxy. A hosted deployment must replace it with real authenticated sessions/reverse proxy and production security controls. The base has no multi-user login, multi-home tenancy, MQTT broker, NILM inference, device relays or external AI.
