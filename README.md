# Current — Energy House Demo

A standalone software concept for the XANIX “Power Without Certainty” opportunity. Its staged household flow follows Hurricare. The visual design follows the supplied energy-app reference: neutral surfaces, system typography, natural house materials, yellow solar and green battery accents. Current is a provisional name.

## Run

Requires Node.js 22.18+ and npm. From this directory:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5182. This is a local preview; no service account, API key, backend or hardware is needed. The app uses system fonts and bundled assets; no external image or font service is required.

```sh
npm test
npm run build
npm run preview
```

The production site is in `dist/`; serve it with a static HTTP server. The supplied archive contains both source and the built site. It excludes dependencies. The live working folder currently links to temporary installed development dependencies; a fresh extracted copy installs normally with `npm ci`.

## Household screens

The app follows Hurricare’s staged presentation: situation → choices → analysis → results. Each screen answers one household question, with Next/Back navigation and direct access from the top bar.

1. **Your home** — a large interactive house, current use, the biggest power user and a clear next action. Tap an appliance to open its details only when needed.
2. **Appliances** — room filters, simple appliance cards and preset-based enrollment. Monitor IDs and simulation controls stay behind Monitor details.
3. **Understand usage** — three separate topics: Biggest users, Cost & sources, and Over time. Rankings explain which appliance uses more; units are explained in plain language.
4. **Backup plan** — Choose essentials → See the difference → Your plan. Compare estimated battery-only time before applying a simulated plan, then try a power cut or restore appliances.

Use **Try a situation** in the header to change the supply scenario, pause/resume the simulation or start over. Cost settings and CSV export are on the relevant usage screens. House viewing controls stay with the house.

## House views and themes

- **Inside** opens a genuine architectural cutaway: the roof and two exterior walls are removed to reveal the rooms, furniture and appliances. Appliance markers remain interactive.
- **Outside** restores the walls, gables, windows and solar roof. Switch back to Inside to select appliances.
- **Room usage** colors rooms by their current power demand and automatically opens the house.
- Use **Light / Dark** in the header to change the entire interface, charts, dialogs, model materials and lighting. The choice is saved in this browser and survives reloads. Dark is the initial default.
- Source callouts show current simulated solar/grid power and battery charge. The source ring on Cost & sources uses the actual demo allocation, not a decorative fixed percentage.

## Present

1. Start at Your home and identify the biggest power user.
2. Select an appliance in the house, then close its details.
3. Go to Appliances, add a water pump using its preset, and pick its room.
4. Go to Understand usage to see the ranked explanation, source breakdown, costs and history one topic at a time.
5. Go to Backup plan, choose essentials, compare runtime and use the plan in the demo.
6. Try a power cut from the result screen. Restore previous appliances when finished.

All switches control simulated state only. Every tick is five simulated minutes, and ticks arrive every two seconds. Session energy and estimated session costs begin at zero. A reload resets the session. Start over resets the simulation and house viewing controls.

## Code map

- `src/HouseScene.tsx`: procedural 3D house, appliance geometry, marker selection, animated wiring, camera controls.
- `src/energy.ts`: shared domain types, scenario assumptions, supply dispatch and energy/cost integration.
- `src/store.ts`: state, device enrollment, signal loss, scenario changes and plan actions.
- `src/App.tsx`: screen navigation, household overview, appliances, usage topics, guided backup plan, enrollment, cost settings and CSV export.
- `src/ui.tsx`: shared icons, time formatting and accessible contextual dialogs with keyboard focus management.
- `src/style.css`: staged layout and responsive structure.
- `src/theme.css`: reference-inspired dark/light colors, surfaces, typography and states.
- `src/theme.ts`: saved theme preference and document appearance.
- `src/energy.test.ts`: eight energy model/state tests, including changing an already applied backup plan.

## Assumptions

Battery capacity 5 kWh, starting charge 72%, reserve 20%, discharge efficiency 90%, inverter 2 kW. Generator 3 kW. Daytime solar 1,050 W; outage solar 180 W; night solar zero. Battery-only runtime comparisons assume no solar contribution and constant known demand. Costs use editable illustrative GHS/kWh values, not verified Ghana utility tariffs: grid 1.95, generator 4.80, battery stored-energy cost 0.60, solar variable operating cost zero.

Source dispatch uses solar first, then available grid/generator, then battery. Battery charging is outside this demo. Device cost and delivered energy are allocated proportionally to known appliance demand. Offline monitors have unknown current load and are excluded from estimates with an incompleteness notice. When supply is insufficient, demand remains visible and a capacity alert explains the deficit.

This prototype does not implement hardware discovery, physical switching, battery charging, duty cycles, inrush, utility tariff blocks, generator startup costs, historical databases or AI inference. Recommendations are explainable deterministic rules. No evidence of real measured savings is implied.

### Selection refinement — October 10

Select a room label in the house (or use the room list) to gently focus that room and see its appliances. Select an appliance to see its reading and share of household power beside the house. “What if this were off?” previews home demand, hourly cost difference and battery-only backup time; “Turn off in demo” applies it. Costs and monitor controls remain available under the detail link. Show whole house returns to the overview.

The Over time screen now has “Explore this chart”, which opens a larger chart with an explanation and a plain-language takeaway. Transitions are brief, manual house interaction interrupts camera movement, and reduced-motion preferences skip camera interpolation. The phone layout scrolls the house away before the details. Dark and light themes remain available.

Validation: TypeScript and production build, eight energy/backup tests, and live Chrome checks of room/device selection, preview/apply/restore, chart expansion, both themes, and a 390 px phone layout.
