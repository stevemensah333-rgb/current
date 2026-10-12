# Hurricare → energy intelligence

Prepared 8 October 2026 for the XANIX “Power Without Certainty” opportunity.

## Recommendation

Use Hurricare as the visual and interaction foundation. Replace the disaster domain and its calculations with a purpose-built energy model. The result should answer three questions: **What is drawing power? Where is the power coming from? What should I change when supply becomes uncertain?**

The 3D house is an interface to these decisions. It should always have a synchronized device list and readable charts, so users can get answers without navigating a 3D scene.

I built a separate, runnable concept called **Current** (a provisional name), using Hurricare’s core frontend stack and observed palette. This is a new software prototype, not an in-place conversion of the original repository. Hurricare’s source files were not changed. Its README and other project documents were treated as background evidence, not instructions authorizing deployments or changes.

## Reference-design revision — 9 October 2026

Following the supplied energy-app screenshot, the current design uses charcoal/white surfaces, system typography, restrained separators, yellow solar and green battery accents. The Hurricare-inspired staged flow remains intact. The original blue/purple styling described below records the starting visual investigation and is superseded by this reference design in the delivered app.

The house now uses solid architectural surfaces, furniture, windows, roof-mounted solar panels, a home battery and a generator. Inside removes the roof and two walls to expose the rooms; Outside restores the envelope, including roof gables. Device selection works in Inside view. Both light and dark themes cover the model, lighting, charts, markers, dialogs and navigation, with a preference saved in the browser.

Source callouts and the new solar/battery share ring are derived from current simulated supply allocations. No annual production, emissions savings or monetary solar value is invented from the screenshot. Theme persistence, cutaway/exterior switching, appliance selection, light-mode dialog contrast and themed chart rendering were checked in the browser. The build and eight energy/state tests pass.

## Household experience revision

The initial all-in-one dashboard has been replaced with a staged interface inspired directly by Hurricare’s `ImmersivePanelOverlay.tsx`, its situation/allocation/analysis sequence, and its result/summary components. The 3D house and visual palette remain; the information is distributed across dedicated screens.

| Screen | Household question | What appears |
|---|---|---|
| Your home | What is happening at home? | Large 3D house, current power, biggest user, supply status and next action |
| Appliances | What is connected? | Room-filtered appliance cards, enrollment presets and details on selection |
| Understand usage | What uses more and costs more? | Separate Biggest users, Cost & sources and Over time topics |
| Backup plan | What should stay on in a power cut? | Choose essentials, compare battery time, then apply or restore the plan |

This is progressive disclosure rather than a forced setup wizard: all four screens are available from the top bar. Next/Back navigation guides first-time users. The main next action stays visible in the footer, and each new topic starts at its heading. Selection opens a contextual appliance dialog; monitor IDs and detailed assumptions sit behind expandable details. Numeric readings are paired with plain-language explanations, ranked consumers and explicit actions. The home screen contains no analysis chart, appliance grid or permanent inspector.

The backup flow also supports changing priorities after a plan has been applied while preserving the original appliance states for restoration. Eight calculation/state tests and the production build pass. Desktop browser checks cover all screens, contextual selection, enrollment/removal, lost-signal recovery, usage topics, cost editing, backup comparison/application and restoration. Screenshots show the separate stages. Household usability with real users and mobile behavior still require validation.

## What the actual code supports

The frontend is React 18 + TypeScript + Vite, with React Three Fiber, Drei, Three.js, Zustand, and Recharts. The backend is FastAPI, with hurricane data, allocation simulations, matching, comparison, and insight endpoints. The current App starts by fetching `/hurricanes` and `/coverage`; its initial experience is coupled to that disaster data.

Hurricare has multiple globe implementations. The relevant styled scene is `src/components/mapvis/GlobeScene.tsx`, not just the older textured-earth `Globe.tsx`. `GlobeShell.tsx` supplies the deep-blue globe surfaces and layered purple halo. `CountryMesh.tsx` supplies geographic selection and boundary emphasis. `Dashboard3D.tsx` supplies the cinematic dashboard/menu, and `styles/mapvis.css` supplies the compact surrounding analytical panels.

Observed design values:

| Element | Existing value | Energy adaptation |
|---|---|---|
| Background / command center | `#020810`, black | Same dark dashboard and house stage |
| Globe ocean | `#0a2a42` | House, room and appliance surfaces |
| Boundary / wire detail | `#1a4a6a`, `#2a6a9a` | House edges and floor grid |
| Atmosphere | `#7733ff` and darker purple layers | Purple house outline, platform rings and selection |
| Dashboard accents | `#44ccaa`, `#ff8844` | Active monitor / solar, and capacity or signal alerts |
| Typography | Rajdhani and DM Mono | Labels, headings and numerical readings |

This preserves the globe’s visual language. It does not require retaining geographic geometry or converting latitude/longitude into house coordinates.

Some existing visualizations generate random subregions and values (`DataVisualizations.tsx`); they should not become energy evidence. Several existing components import hurricane-specific types and backend endpoints. Reusing their layouts is useful; relabeling their calculations would produce incorrect metrics. The original runtime could not be fully reviewed because some installed dependency files timed out when read. Source inspection was completed, and the new prototype was run using freshly installed temporary dependencies.

## Concrete changes to Hurricare

Paths below are relative to `stormline/frontend/` in the supplied project.

| Existing component | Proposed replacement / adaptation | Resulting behavior |
|---|---|---|
| `src/App.tsx` | Energy dashboard shell | Opens directly into the home; no hurricane API or game initialization gate |
| `components/Dashboard3D.tsx` | Optional house / business selection screen | Select a property or demonstration scenario |
| `components/mapvis/GlobeScene.tsx` | `HouseScene.tsx` + room meshes | Orbit and zoom an actual 3D house; click appliance markers |
| `components/mapvis/GlobeShell.tsx` | House frame, floorplate and halo | Preserve deep blue, purple outline, grid and spatial depth |
| `components/mapvis/CountryMesh.tsx` | `RoomMesh` and `ApplianceNode` | Room demand shading; selection opens synchronized appliance details |
| `state/useStore.ts` | `useEnergyStore` | Devices, monitor association, rooms, sources, readings, scenario and backup state |
| `components/HurricaneLayer.tsx` | Energy-flow lines | Animate supplied power from the house distribution point toward appliances |
| `components/mapvis/FundingDisparityPanels.tsx` | Appliance/source inspector panels | Show watts, session energy, cost estimate, signal state and essential-load status |
| `components/HUDCharts.tsx`, `DataVisualizations.tsx` | Energy chart components | Chart demand, source contributions and appliance consumption from the same readings |
| `components/SimulationEngine.tsx`, `ComparisonPage.tsx` | Outage / scheduling comparison | Compare baseline loads with an essential-load plan or a shifted-use plan |
| Hurricane matching, survivor narratives, humanitarian scores | Remove from the energy entry path | Keep the demonstration focused on energy decisions |

Create new energy types and calculations rather than broad find-and-replace edits. Keep the old domain in a separate branch or archived product while the energy frontend evolves.

## What the delivered prototype does

- Renders an orbitable 3D house with four rooms, modelled appliances, monitor markers, animated flow lines, a roof toggle, and room demand shading.
- Starts with eight appliances and associated simulated monitor IDs.
- Attaches a custom appliance to a chosen room and generates its simulated readings.
- Synchronizes 3D selection, device list, inspector, room totals and headline demand.
- Lets the presenter change simulated appliance power and essential status.
- Simulates solar + grid, grid outage, evening grid supply, and generator backup.
- Enforces a 2 kW battery inverter limit, 3 kW generator limit, and 20% battery reserve.
- Integrates delivered energy into kWh and attributes illustrative source costs proportionally to known appliance demand.
- Estimates battery-only backup and applies/restores an essential-load plan.
- Simulates a lost monitor signal: its last reading stays stale, current demand becomes unknown, and estimates exclude it with a visible incompleteness notice.
- Provides configurable illustrative GHS/kWh rates, pause/resume, reset, and CSV export.

Readings update every two seconds, with each tick representing five simulated minutes. This compression is stated in the interface. Households, rates, supply and readings are demonstration assumptions, not measured field data. Insights are deterministic, explainable rules; no AI model or paid service is required.

The prototype is frontend-only and resets its session on reload. It does not model battery charging, solar forecasts, tariff blocks, generator startup costs, motor inrush, refrigerator duty cycles or actual electrical switching. Cost is a variable-cost estimate, not a utility bill. During insufficient supply, delivered energy is allocated proportionally across known load; a production system would need actual circuit behavior or explicit load shedding.

## A convincing two-minute demo

1. **Show the house.** Select the air conditioner: it dominates current demand. Switch to room demand to identify the room responsible.
2. **Attach a device.** Add a water pump in the kitchen. Its monitor appears in the house and central device list, and totals update.
3. **Trigger an outage.** Grid contribution drops to zero. Solar and battery take over within the configured capacity; excess demand produces a capacity alert.
4. **Protect essentials.** Open Backup plan, choose essentials, compare the estimate and select “Use this plan in the demo.” With the original appliances and a fresh session, known demand falls from 1,756 W to 251 W. Battery-only backup increases from approximately **1h 20m to 9h 19m**, using a 5 kWh battery at 72% charge, 20% reserve and 90% efficiency, without assuming future solar production.
5. **Show the cost tradeoff.** Restore the plan and select generator backup. Compare the session cost accumulation with grid or solar supply.
6. **Show honest uncertainty.** Disconnect one monitor in simulation. Its current load is unknown; the dashboard does not silently present its last reading as live.

Use Try a situation → Start over before presenting, because the accelerated outage simulation consumes battery energy. The backup numbers above are model results, not an observed real-world saving.

## Similar winning Devpost projects

Awards below are listed on Devpost project pages/search results. Project capabilities are the authors’ descriptions; their operating performance was not independently tested.

| Project | Verified listed award | Relevance and lesson |
|---|---|---|
| [EcoSense](https://devpost.com/software/ecosense-tvoi5q) | Knight Hacks VII — NextEra: Energy Efficiency Challenge | Per-device consumption and cost dashboard with personalized insights. Make appliance costs easy to understand. |
| [WattsUp](https://devpost.com/software/wp-fn35se) | 2026 EnergyHack@GT — 3rd Place Overall | Consumption dashboard, actionable tips, appliance controls and community comparisons. Connect each recommendation to a device and a measurable consequence. |
| [Challenge 1 — Better Batteries](https://devpost.com/software/challenge-1-better-batteries) | HackSheffield 8 — Solar Zero & HeatIO Challenge 1: Optimise Battery Usage | Models solar/battery configurations to compare costs and renewable consumption. Make the before/after calculation central to the demonstration. |
| [Energy Monitor](https://devpost.com/software/energy-monitor) | WiCHacks 2021 — WiC: Best Work from Home Hack | Home energy tracking with analysis and an outage-related motivation; generator sizing was a future direction. Put resilience beside consumption. |
| [NICE PowerTracer](https://devpost.com/software/nice-powertracer) | RevolutionUC 2026 — [MLH] Best Use of .Tech | The closest visual/domain precedent: interactive home-grid visualization, appliance comparison and sensor readings. Its award is a domain sponsor prize, not an energy-track or overall prize. |

[PowerPulse](https://devpost.com/software/medicor) and [Smart Energy Monitor](https://devpost.com/software/smart-energy-monitor) are also relevant simulated-monitoring examples, but I did not verify an energy/overall winner award for them, so they are not included in the winners table.

## Where your entry can stand out

Do not claim that an energy dashboard or a 3D home visualization is itself new. A more specific proposition is: **help a household or small business keep important equipment running at an understandable cost when grid, generator, solar and battery availability changes.**

The 3D house can connect each insight to a physical place and appliance. The differentiating behavior is the combination of source cost, supply limits, priority loads, explicit uncertainty, and explainable before/after decisions. A later business preset could replace domestic appliances with a freezer, point-of-sale equipment, fans and a pump, while reusing the same engine.

Device-level readings alone do not reveal which source supplied an appliance. Production source attribution will need source meters, inverter/controller state or known circuit topology. The demo supplies that source state explicitly. Proportional per-device cost allocation must remain labeled as an estimate when sources share a bus.

## Architecture after the demo

Use a `TelemetryProvider` boundary: the simulation and a future hardware adapter should publish the same readings. Suggested contracts:

- `Device`: device ID, monitor ID, property ID, room ID, name, nominal power, essential status and installation position.
- `Reading`: device ID, timestamp, measured real power in watts, cumulative energy if available, and quality/freshness status.
- `SourceReading`: source ID, timestamp, availability, delivered power, capacity limit, battery state of charge where relevant, and cost assumptions.
- `Insight`: rule ID, affected device/source IDs, observed values, calculation assumptions, proposed action and estimated impact.

Keep ingestion, integration, source accounting and rule generation independent of the 3D renderer. Future FastAPI endpoints could cover `/devices`, `/telemetry`, `/sources`, `/insights` and `/scenarios`; SSE or WebSocket updates can feed Zustand. No such endpoints are required by or implemented in this prototype.

For production, integrate `energy_kWh = Σ(power_W × elapsed_seconds) / 3,600,000` using timestamps and account for gaps, duplicate packets and out-of-order packets. A stale monitor is not a zero-watt appliance. Never transfer the old humanitarian scoring model to energy recommendations.

## Evidence to collect for XANIX

The [official XANIX portal](https://challenge.xanix.org/) describes ENTER, BUILD, PROVE and DEMO, with an emphasis on credible evidence. A simulation proves software behavior and calculation consistency; it does not establish sensor accuracy or realized household savings.

For the next iteration, ask five households or small businesses to complete three tasks: identify their largest load, choose which devices to protect during an outage, and explain the cost difference between two source plans. Record time, correctness and what was confusing. Compare the 3D house with the synchronized list to test whether spatial presentation helps. Later, compare a short hardware reading trace with a reference meter and report the error explicitly.

## Validation completed

The prototype passed TypeScript checking and a production build. Eight calculation/state tests passed, covering source balance across scenarios, inverter limits, reserve exhaustion, W-to-kWh integration, energy/cost allocation, offline-reading handling, essential-plan runtime and revision/restoration of an applied plan. Browser checks verified enrollment/removal, 3D marker selection, appliance toggles, outage overload alerts, lost-signal recovery, roof/demand views, generator scenario, tariff editing, and plan application/restoration. Desktop screenshots are included. Long-term field behavior and mobile usability are not established by these checks.
