# Smart Home Power: software design

One clamp sensor. The software names which devices are on, tracks their power, warns before faults,
and lets a small language model (SLM) act on them.

Every number below says where it comes from. Nothing is taken from the old NILM code.

## The pipeline

```
board text ─► 1 Transformation ─► Cycle ─► 2 Event detector ─► Event ─► 3 Signal extractor ─► Signature
                                    │                                                         │
                                    └──────────► 7 Power monitor                               ▼
                                                      ▲                       4 Library (teach mode)
                                                      │                                       │
                                  6 House state ◄── 5 Classifier (TimEE) ◄────────────────────┘
                                      │   └──────► 8 Fault monitor
                                      ▼
                                  9 SLM control
```

| # | Stage | In | Out | Status |
|---|---|---|---|---|
| 1 | Transformation | text lines | `Cycle` | built |
| 2 | Event detector | `Cycle` | `Event` | built |
| 3 | Signal extractor | `Event` | `Signature` | this design |
| 4 | Library | `Signature` + name | `DeviceEntry`, `library.json` | this design |
| 5 | Classifier | `Signature` + library | `Prediction` | this design |
| 6 | House state | events + predictions | on-list, usage log | this design |
| 7 | Power monitor | `Cycle` | VA, energy, drift flags | this design |
| 8 | Fault monitor | switch-ons + baseline | fault log, alerts | this design |
| 9 | SLM control | house state | tool calls | this design |

The old "Loader" box is gone. `shp/sources.py` (file, serial, record) already does that job.

## What the firmware must send

`s,<ms>,<n>,<r1>,...,<r17>`: 17 readings in amps, offset removed, taken at about 860 per second.
`n` is a running count: the number of the first reading in this line, counted from boot.
Lines run back to back, so each line's `n` is 17 more than the last. If it is not, a reading was lost.
One lost reading moves the clock by about 21°, and only this counter can show it.

860 / 50 = 17.2 readings per mains cycle, so a line covers about 0.988 of a cycle and each line starts a little
earlier in the wave than the last. That is fine: the software uses the true position of every reading (stage 3).

**Change to stage 1 (done).** The transformation reads `n` and sets `gap_before` when `n` is not the last `n` + 17.
The 30 ms time check stays for board restarts. Its tests and test file now use the new format. There are no saved
recordings in the old format yet, so nothing else needs converting.

---

## 3 Signal extractor: `shp/extractor.py`

**Job.** Turn an `Event` into the device's own signal: what the device adds (on) or removes (off).

**Small example.** A fridge draws 1.0 A. A kettle switches on. The house now draws 9.7 A.
The extractor subtracts the "before" wave from the "after" wave and gets the kettle's wave on its own.

### One shared clock

To subtract two waves, both must be measured against the same clock. Otherwise the old part of "after"
lands in a different place from the same part in "before", and the leftover looks like a device.
Example: the kettle is on (9.7 A) and a phone charger joins. If the clock is off by just 1°, the kettle part
fails to cancel and leaves 0.17 A. That is as big as the charger itself.

We have that clock: the reading counter `n`. What we do not know exactly is **how far the mains wave moves
per reading**. It is about 50 / 860 of a cycle, but the mains is not exactly 50 Hz and the board is not exactly
860 per second (its chip is only accurate to about ±10 %). So we always measure it, never assume it.

How: over a steady stretch, the main wave should sit still from line to line. If it creeps forward or back,
the creep tells us the true "mains cycles per reading". Example: if the main wave's start moves 4.3° later on
every line, that drift tells us exactly how far the mains moves per reading.
We measure it from, in order of preference:
1. the before window, if its current is big enough (above 5 × threshold_a);
2. otherwise the after group. When before is about zero, the after wave is the device alone;
3. otherwise a stored value that `calibrate` measures once from the `--load` recording (one steady device)
   and saves in `settings.json`. If none is stored, 50 / 860 is used and the signature is marked low_trust.

### Steady shape (50 numbers)

```
pick two groups of 10 cycles:
  before = event.before                         # 10 steady cycles just before the step
  after  = the first 10 settled cycles of event.after   # settled = from the settle time on; close to the step
fit each group with: main wave (50 Hz) + 7 ripple waves (100 … 400 Hz)   # 17 readings carry up to the 8th
  using the counter position of every reading and the measured mains cycles per reading
own_wave = after_fit − before_fit                  # on;  off = before_fit − after_fit
slide own_wave in time so its main wave crosses zero going up at the start   # same place for every switch
rebuild it as 50 points over one cycle
size_a = RMS of those 50 points (amps)       # RMS: square every value, average, take the square root.
                                             # It is the "effective" size of a wave.
steady = the 50 points ÷ size_a                    # scaled so its RMS is 1; real amps kept in size_a
```

"Slide in time" means: a cycle that starts a quarter-wave late is moved back a quarter-wave. The ripple waves
move with it (the 2nd ripple moves twice as far in angle, the 3rd three times, and so on).

### Surge shape (switch-on only, 50 numbers)

```
surge[i] = (current_a of after cycle i − before level) ÷ |step_a|     for the first 50 after cycles
```
1.0 means "already at the new steady level". Example: the charger's first cycle draws 3.7 A extra and its
settled step is 0.15 A, so surge[0] = 3.7 ÷ 0.15 ≈ 23. Switch-offs have no surge, so `surge` is empty.

### Settle time

The first cycle after which `current_a` stays within `threshold_a` of the settled level, × 20 ms.

### Trust flags

- **`shape_ok = False`** when the event has a gap (`clean = False`). Across a gap the clock is lost, so no
  steady or surge shape is made, only the step size.
- **`low_trust = True`** when either:
  - |step_a| < 0.3 × before level. Why 0.3: the leftover error is about the before current × the clock error.
    1° of error is 1.7 %. With the before current 3.3 times the step, the error is 3.3 × 1.7 % ≈ 6 % of the
    device's signal. The 1° is an estimate, to be checked on real recordings.
  - the clock was carried from the before window (option 1), and the after group starts more than 25 cycles
    (0.5 s) later. The further we carry the clock, the more a small mains wander adds up: 0.01 Hz over 1 s is
    already 3.6°. In a quiet house (option 2) nothing is carried across the step, so slow-settling devices
    such as fridges and fans are not caught by this rule.
  Both numbers are settings. Low-trust signatures are still classified, but not taught or logged as faults.

### Known limits

- Ripple above 400 Hz cannot be seen. At 860 readings per second it shows up at odd frequencies (450 Hz looks
  like 410 Hz), and the 10-cycle fit mostly averages it away. We lose that detail; it does not corrupt the rest.
- A voltage sensor (ZMPT101B) would give an exact clock and true watts. It is a near-term upgrade.

**Output: `Signature`**

| Field | Meaning |
|---|---|
| `direction` | +1 on, −1 off |
| `t_ms` | time of the step |
| `steady` | 50 numbers, RMS 1 (empty if `shape_ok` is False) |
| `surge` | 50 numbers (on only, and only if `shape_ok`) |
| `size_a` | RMS of the device's own wave (A) |
| `step_a`, `step_va` | step size: amps, and 230 × amps |
| `settle_ms` | how long the device took to settle |
| `clean`, `settled`, `shape_ok`, `low_trust` | trust flags |

---

## 4 Library (teach mode): `shp/library.py`

**Job.** Store labelled examples of each device so the classifier can compare against them.

**Small example.** You type "kettle", then switch it on and off 5 times. Each switch gives one `Signature`.
The 5 on-signatures and 5 off-signatures are stored as separate examples. A summary of them becomes the
kettle's fixed baseline for the fault monitor.

### Turns

A turn is one switch-on followed by its switch-off. Registration needs exactly 3 kept turns.
It starts with 2 s of the appliance off: the quiet line sets the threshold (5 x its flicker, never below the saved floor).
During a turn, a change under half the switch-on is the appliance's own wobble and is ignored.

```
session = TeachSession("kettle", setting=None)
for each signature during registration:
  refuse it only if: not clean (lost readings) or not shape_ok (no wave) # refused switches do not count
                                             # low_trust → "switch off other big loads and try again"
  switch-on  → hold it and ask for the switch-off
  switch-off → with the held switch-on it makes a turn, kept as measured (TimEE judges similarity later)
  a change under half the switch-on while a turn is open is the appliance's own wobble: ignored
  an unusable switch-off (lost readings, no wave) is a redo; stop after 5 redos
session.finish(): needs 3 kept turns → 3 on- and 3 off-examples
Each turn also keeps its raw waveform: 10 cycles before and every cycle after both switches.
The app stores it with the turn (registration_turns table in the backend database).
```

**Odd-round rule, with numbers.** Steps of 2000, 2010 and 2500 VA. The middle value is 2010. Distances from
it: 10, 0, 490. The middle distance (the MAD) is 10. A round is odd if its distance is more than
3 × MAD, but never less than a floor. Here 490 > 30, so the 2500 round is odd and is redone.

- Step floor: 230 × threshold_a, the smallest step the detector can see.
- Shape floor: a shape distance of 0.1. Shape distance = RMS of the difference between two steady shapes.
  0.1 = 10 % of the shape's own size, the smallest difference we treat as real.
- When rounds are identical, MAD = 0 and the floor decides. That is expected.

**Settings** (e.g. mixer speeds 1, 2, 3) are taught as separate sessions with the same name.
The classifier label is `"mixer|speed 3"`. Usage and the SLM merge them back into "mixer".
A change of setting while the device runs (speed 2 → 3) gives a step that matches nothing. That case is deferred.

### Baseline (fixed after teaching, never shown to TimEE)

Average steady shape and average surge, plus a normal **range** for each value:

| Value | Range | Why |
|---|---|---|
| step_va, size_a | mean ± max(3 × sd, 10 % of mean) | 5 quiet rounds give a near-zero spread; Ghana's grid swings ±10 % |
| surge peak | mean ± max(3 × sd, 10 % of mean) | step-scaled (surge ÷ step), so grid voltage cancels out |
| settle_ms | mean ± max(3 × sd, 20 ms) | 20 ms = one cycle, the finest the readings can show |
| shape_diff | below max(teach odd-round shape limit, 0.1) | live switch-ons sit further from quiet rounds; a named setting to tune |

### Two libraries (PROJECT_CONTEXT "Handling variation")

- **Baseline**: fixed at teach time. Used only by the fault monitor.
- **Working**: the teach examples plus confident live switch-ons, newest 20 per device. Used by the classifier.
  A live switch-on joins only if it is clean, settled, shape_ok, not low_trust, power_match, not unknown,
  and p ≥ 0.9. 0.9 and 20 are settings.

**Storage.** One JSON file, `library.json`. Plain text, so it is easy to inspect and back up.

---

## 5 Classifier: `shp/classifier.py`

**Job.** Name the device in a new `Signature`, with a probability, or say "unknown".

**TimEE** (`pip install timee-ts`, Apache-2.0): `predict(X_train, y_train, X_test)` with `X` shaped
`(n, channels, length)`. No training. Each channel is classified on its own and the probabilities averaged.

```
switch-on:
  channels   = [steady, surge]                         # both 50 long
  candidates = all devices in the working library, examples = their on-rounds
switch-off:
  channels   = [steady]                                # no surge on switch-off
  candidates = devices on the on-list, examples = their on-rounds and off-rounds
power check:
  keep candidates whose step matches |step_va| within  max(teach range, 10 %) + 230 × threshold_a
  switch-off: compare with that on-list entry's own recorded step, as PROJECT_CONTEXT says
no shape (shape_ok False):  decide by the power check alone:
  closest step_va wins, p = 1 − distance ÷ tolerance, source "power"; a tie → unknown
decide:
  no candidates left                 → unknown
  one candidate                      → that label, p = shape match score (below)
  two or more                        → TimEE.predict → ranked labels and p
  shape distance to the nearest example of the winner > unknown_limit → unknown
always record: nearest device and its shape distance, even for unknown
```
If even the best match looks too different from every example we have, we say "unknown" rather than guess.
`unknown_limit` starts at max(the device's odd-round shape limit, 0.1) and is a named setting to tune on
recordings: live shapes with other loads on sit further from the quiet teach rounds.

Switch-off with identical labels (two lamps): repeats are removed before calling TimEE. The house state then
removes the matching entry whose `step_va` is closest. An "unknown" on-list entry has no library examples, so
it is matched by its own stored steady shape and step.

Shape match score (one candidate only, where TimEE needs two classes): 1 − distance ÷ limit, kept between 0 and 1.
It is not a TimEE probability, and `Prediction.source` says so.

The TimEE model sits behind a small interface (`predict(X_train, y_train, X_test)`) and loads on first use.
Tests use a simple stand-in with the same interface.

**Output: `Prediction`**: `label` (or `"unknown"`), `p`, `ranked`, `power_match`,
`source` ("timee", "match", "power", or "none" when nothing matched), `matched` (False when nothing matched;
a matched "unknown" means an unknown on-list entry), `nearest`, `nearest_distance`.
If no matched candidate has a shape to compare (an unknown entry that switched on across a gap), the power check decides.
TimEE's probability columns are assumed to follow the sorted labels; every call checks this against its top prediction.

---

## 6 House state: `shp/house.py`

**Job.** Keep the on-list: which devices are on now, since when, with what confidence.

The on-list is a list of entries, not a set of names, so two identical lamps can both be on.
Each entry: `label`, `p`, `since_ms`, `step_va` (its own recorded switch-on step), and its own `steady` shape
(so an "unknown" entry can still be matched when it switches off).

```
on event:   prediction = classify(...); add an entry (unknown devices too, labelled "unknown")
off event:  prediction = classify(..., candidates = on-list entries)
            matched → remove that entry
            nothing matches → remove nothing, log "unexplained switch-off", ask the power monitor to re-anchor
summary():  "kettle ON 0.94, fridge ON 0.88, unknown ON"      # the SLM state line
log every change: (t_ms, label, on/off, p)                   # gives usage and energy per device
```

---

## 7 Power monitor: `shp/power.py`

**Job.** Once a second: total power, energy, and a check that nothing switched unseen.

The board measures current only. 230 V × current is **apparent power in VA**, not true watts.
True watts need the voltage sensor. Everything here is labelled VA.

```
every 50 cycles (1 s):
  va      = 230 × average current_a
  energy += va × 1 s                          # VA-hours
self-check (drift since the last event):
  after every event: anchor = 230 × the event's settled level; the second in progress is skipped
  if va has stayed more than the tolerance away from the anchor for 5 s, look at how it got there:
      most of the change came within 2 s → a step: log "missed event" with its size, then re-anchor
      it crept there slowly             → the grid: re-anchor quietly
  tolerance = max(2 × 230 × threshold_a, 5 % of anchor)
per device (from the house-state log): on-time and VA-hours = step_va × time on
```
Why re-anchor instead of adding up devices: currents of devices that are out of step do not add.
A kettle (8.7 A) plus a fridge (1 A, 40° out of step) gives about 9.5 A, not 9.7 A.
It also avoids needing to know what was already on at start-up.
5 s ignores a surge or a slow settle. `× 2` leaves room for noise on both the anchor and the reading.
5 % of anchor: a 10 A house at ±10 % grid swing moves about 1 A, and a sag is slow, so it is not a step. All are settings.

---

## 8 Fault monitor: `shp/faults.py`

**Job.** Spot slow drift in a device before it fails.

```
for every switch-on with a known label, power_match, shape_ok, not low_trust, clean, settled:   # no p gate
  compare with that device's baseline:
    shape_diff = RMS(steady − baseline shape)
    surge_peak, settle_ms                     # alert on these three
    size_a, step_va                           # logged only: they follow the grid voltage
    p                                         # logged: a slow drop is an early warning
  log one row
also log unknown switch-ons with their nearest device and distance       # a device sliding out of range stays visible
each day: average the rows per device
alert when a daily average sits outside the baseline range for 3 calendar days in a row (once per streak)
```
No p ≥ 0.9 gate: a failing device's p falls, and a gate would hide it just when it matters.
size_a and step_va move with the grid (±10 %), so they raise no alerts until the voltage sensor exists.
3 days: one odd day is not a trend. It is a setting.

---

## 9 SLM control: `shp/control.py`

**Job.** Let a small language model read the house state and act through three tools.

```
starts when: the user asks something, or the fault monitor raises an alert
             (when an alert starts the loop, the model may only call notify_user)
state line:  house.summary() + open alerts
tools:
  switch_off(device)          → device must be on the on-list (by merged name: "mixer" matches "mixer|speed 3");
                                asks the user to confirm first
  get_usage(device, period)   → on-time and VA-hours from the house-state log
  notify_user(message)        → shows / sends a message
loop: send state + request → run tool calls → send results back → final answer
      at most 5 rounds, then stop and tell the user
```

- The model is **LFM3-1.7B** (Liquid AI, LFM Open License v1.0), the GGUF build, served by LM Studio on its
  OpenAI-style endpoint (`lms server start`, `lms load lfm3-1.7b`, port 8000), at the model card's temperature 0.1.
  It sits behind one interface: `chat(messages, tools) → reply`, using only the Python standard library.
  LFM3 writes tool calls as XML; LM Studio converts them, and the adapter also reads raw XML if a server does not.
- On this PC (CPU only) one answer takes about 1–3 minutes, because the model reasons before it answers.
- `switch_off` goes through a `Switch` interface. Until relays or smart plugs exist, it logs the request and
  tells the model "no switch fitted for <device>".
- Tests use a scripted stand-in model.
- Deferred: a front end for the user to type questions. `Controller.ask()` is ready for it; `run --slm` handles alerts.
- Open alerts are kept until `acknowledge()`, at most 10, so the state line stays short.

---

## Running it: `shp/app.py`

```
uv run python -m shp.app record    --port COM6 --out session.txt    # save raw lines
uv run python -m shp.app calibrate --in quiet.txt --load lamp.txt   # quiet → threshold_a; one steady load →
                                                                    # mains cycles per reading; both in settings.json
uv run python -m shp.app teach     --port COM6 --name kettle        # guided teach mode
uv run python -m shp.app run       --port COM6                      # live pipeline
```
Every command also takes `--in <file>` instead of `--port`, so a saved session replays through the same code.

**Time.** Board time becomes wall-clock time with an offset: live from the PC clock, in a replay from board time
itself, so a replayed week spans a week. The offset changes only when board time goes backwards (a restart).
Fault-monitor days come from the event's wall time.

## Testing

Each stage has its own tests with small hand-built inputs of known values (fixtures, not a simulated house).
Real recordings become tests once the firmware sends `s` lines.
