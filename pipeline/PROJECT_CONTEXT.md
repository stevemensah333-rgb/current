# Smart Home Power: Project Context

Design doc (source of truth for decisions): https://claude.ai/artifact/Y8H525oN7cvoArcYGQzgSB

## Goal

A non-intrusive device that reads a home's current through one clamp sensor, names which appliances are on, tracks their usage, predicts faults, and lets a small language model (SLM) control appliances through tool calls.

## Starting point

Base paper: Jayakrishnan B et al., "Real-Time NILM-Based Smart Energy Monitoring Using AI and IoT", ICIET 2026, https://doi.org/10.1109/ICIET70550.2026.11712727

- Hardware: SCT-013 clamp on the live wire, a resistor-divider + capacitor bias circuit, ESP32 ADC, Wi-Fi to a cloud server.
- Their method: low-pass filter (alpha = 0.3), fixed windows, two features (RMS current, apparent power = 230 V x Irms), Random Forest (100 trees), majority-vote smoothing.
- Tested on three appliances (hair dryer, mixer, iron box), 92-97% accuracy.
- We keep the hardware and replace their two numbers with the device's own waveform.

## Our design

### Classifier
- TimEE (Kuken et al., 2026, https://huggingface.co/papers/2607.07500, code https://github.com/automl/timee): 4.5M params, labels a new series from a few labeled examples in one forward pass, no retraining.
- TimEE runs only at switching events (current steps up or down), not continuously.
- One event gives one device, so several devices on at once is handled by classifying events, not the whole-house signal.
- Runs on the hub, not the ESP32 (too big for ESP32 memory).

### Sensing changes vs the paper
- Same SCT-013 clamp; it already outputs the waveform shape.
- Sample faster: 2-5 kHz (40-100 points per 50 Hz cycle), using ESP32 DMA/I2S ADC mode for steady timing.
- Remove the paper's smoothing filter; it erases the detail that tells devices apart.
- Optional later: ZMPT101B voltage sensor for real power and power factor.
- Current test sketch reads the clamp through an ADS1115 (A0, I2C on GPIO 21/22). Its max 860 samples/s gives ~17 points per 50 Hz cycle: fine for RMS current and power, too slow for the device's own signal. For waveform shape, move to the ESP32 ADC (GPIO 32-39) at 2-5 kHz.

### The device's own signal
- Term we use instead of "after minus before".
- At a step, compare the waveform just before and just after; the difference is the device that switched on (or off).

### Data
| Data | When collected | Used for |
|---|---|---|
| Raw current samples, 2-5 kHz | Always, short rolling buffer on ESP32 | Spotting steps; mostly thrown away |
| Power reading, once a second | Always | Energy, cost, self-check vs on-list |
| Event window: device's own signal (surge + steady), power step, time | Every step | TimEE classifies it; on-list updates |
| Registration examples: same + device name | Teach mode | The home's library TimEE compares against |
| On/off log: device, time, probability | After each classification | Per-device usage; SLM state summary |
| Each device's own signals over weeks | From every event | Fault prediction (drift from baseline) |

### Registration (teach mode)
- User taps "Register device" in the app, names it, and does 3 turns (switch on, let it settle, switch off), starting with it off; nothing else in the house should change.
- Each turn is stored with its raw waveform (10 cycles before and every cycle after both switches).
- Each switch-on saves one record:
  - name (the label TimEE returns), event type (on/off), optional setting (e.g. "speed 3")
  - steady shape: 10 settled cycles, aligned at upward zero crossing, averaged into one cycle, scaled to unit size (~100 numbers at 5 kHz)
  - surge shape: current size per cycle for the first ~1 s (~50 numbers)
  - size (the scale removed, in amps), power step (W), timestamp
- Each switch-off saves the steady signal as it disappears plus the power drop.
- All 3 records are stored separately as TimEE examples. Do not average them for classification.
- Per-device summary: average shape (fixed fault baseline, never shown to TimEE) and typical power step with tolerance (e.g. 2000 W +/- 50 W).
- Registration keeps every usable turn (no lost readings, a wave to learn from) as it is, natural variation included.
- No hand-made similarity rules: TimEE judges similarity when it names a live switch against all the kept turns.
- Device settings (e.g. mixer speeds): register each setting under the same device name.

### Detecting switch-on
- ESP32 watches for a step up (threshold on power change, as in the paper's Eq. 1-2), captures before/after windows, extracts the device's own signal, sends it to the hub.
- TimEE classifies it against the library; the hub keeps an on-list of devices with probabilities.

### Detecting switch-off
- On a step down, extract the own signal of the device that left.
- TimEE compares it only against devices currently on the list, using their steady shapes (switch-offs have no surge).
- Power check: the drop should match what that device added when it came on.
- Self-check: if total power drifts from the sum of the on-list, an event was missed; re-check.

### Handling variation
- Voltage swings: scale signals to unit size; keep real size separately.
- Window start: align at the upward zero crossing.
- Warm-up: take steady window after settling; average 10 cycles.
- Other devices changing mid-window: short windows close to the step; power check catches mismatches.
- Slow change: keep two libraries, a fixed registration baseline (faults) and a working library that adds confident examples (classification).

### SLM control layer
- SLM gets a short state summary, e.g. "kettle ON 0.94, fridge ON 0.88".
- Tools: switch_off(device), get_usage(device, period), notify_user(msg).
- Switching needs a smart plug or relay per device; the clamp only listens.
- Planned model: a small LFM model (~1.7B) for tool calling.

### Fault prediction
- At every confident switch-on, compare with the device's baseline and log: shape difference, size (A), power step (W), surge peak and settle time.
- Average per day/week; alert when the trend stays outside the registration spread.
- TimEE's confidence that "this is still your fridge" slowly dropping is a cheap early warning.

## Deferred
- Whole-home scaling (clamp on the main live wire, 100A current-output SCT-013 with burden resistor, voltage sensor).
- Thermostat cycling (iron, fridge) and setting changes, removed from the doc for now.
