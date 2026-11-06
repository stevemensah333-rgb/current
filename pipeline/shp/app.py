"""Command line for the whole pipeline.

  record    --port COM6 --out session.txt          save the board's raw lines
  calibrate --in quiet.txt --load lamp.txt         measure threshold_a and the clock -> settings.json
  teach     --port COM6 --name kettle [--setting]  guided teach mode -> library.json
  run       --port COM6 [--slm [URL]]              live pipeline; --slm uses LFM3-1.7B in LM Studio

Every command takes --in <file> instead of --port, so a saved session replays through the same code.
"""
import argparse
import datetime
import os
import statistics
import time
from pathlib import Path
from typing import Callable

from shp.classifier import Model, TimeeModel, classify, off_candidates, on_candidates
from shp.control import Controller, LocalChatModel
from shp.detector import STEADY_CYCLES, Detector, calibrate
from shp.extractor import extract, measure_clock
from shp.faults import FaultMonitor
from shp.house import House
from shp.library import Library, TeachSession
from shp.power import PowerMonitor
from shp.settings import MAINS_V, Settings
from shp.sources import from_file, from_serial, record
from shp.transform import CYCLE_MS, transform

HERE = Path(__file__).resolve().parent.parent          # the pipeline folder
STATE = Path(os.environ.get("NILM_STATE_DIR", HERE))   # where settings, library and fault history live
SETTINGS = STATE / "settings.json"
LIBRARY = STATE / "library.json"
FAULTS = STATE / "faults.json"
REPO = HERE.parent
DEFAULT_DB = REPO / ".data" / "nilm.sqlite"


def day_of(wall_ms: int) -> int:
    """Calendar day number of a wall-clock time. In a replay wall time is board time since boot,
    so days count from the recording's start (shown as 1970 dates); streaks still work."""
    return datetime.datetime.fromtimestamp(wall_ms / 1000).date().toordinal()


class Pipeline:
    """Cycle in, house state out. Every stage after the transformation runs here.

    Time: board time (t_ms) is turned into wall-clock ms with an offset. Live, the offset comes from
    now_ms. In a replay (now_ms=None) board time itself is used, so a replayed week spans a week.
    The offset changes only when board time goes backwards (a board restart), so time never jumps back.
    """

    def __init__(self, settings: Settings, library: Library, model: Model, faults: FaultMonitor | None = None,
                 now_ms: Callable[[], int] | None = lambda: int(time.time() * 1000)):
        self.s, self.library, self.model = settings, library, model
        self.now_ms = now_ms
        self.detector = Detector(settings.threshold_a)
        self.power = PowerMonitor(settings)
        self.faults = faults or FaultMonitor(settings)
        self.offset = None
        self.last_wall = None
        self.house = House(to_wall=lambda t: t + (self.offset or 0))
        self.alerts = []
        self.events: list[tuple] = []   # (direction, signature, prediction) since the caller last cleared it
        self.flags: list[dict] = []     # structured alerts since the caller last cleared it
        self.health: list[dict] = []    # device health summaries since the caller last cleared it
        # Registration: while a TeachSession is set, every switch goes to it instead of the classifier,
        # so the device being registered is never named, logged or alerted on. Mains keeps measuring.
        self.teach: TeachSession | None = None
        self.teach_turns: list = []     # Turn results since the caller last cleared it

    @property
    def capturing(self) -> bool:
        """True while a step is being captured: its result is not known yet."""
        return self.detector.after is not None or self.detector.held_before is not None

    def _update_offset(self, c) -> None:
        if self.offset is None:
            self.offset = self.now_ms() - c.t_ms if self.now_ms else 0
        elif c.t_ms + self.offset <= self.last_wall:          # board restarted
            next_wall = self.last_wall + CYCLE_MS
            self.offset = max(self.now_ms() if self.now_ms else next_wall, next_wall) - c.t_ms
        self.last_wall = c.t_ms + self.offset

    def feed(self, c) -> list[str]:
        """Returns plain messages about anything that happened on this cycle."""
        out = []
        self._update_offset(c)
        _, flag = self.power.feed(c)
        if flag:
            out.append(f"power: {flag.kind}, {flag.delta_va:+.0f} VA")
            if flag.kind == "missed event":
                self.flags.append({"kind": "missed_event", "t_ms": flag.t_ms, "device": None,
                                   "value": None, "amount": flag.delta_va})
        event = self.detector.feed(c)
        if event is None:
            return out
        sig = extract(event, self.s)
        if self.teach is not None:
            turn = self.teach.add(sig, event)
            self.teach_turns.append(turn)
            out.append(f"REGISTER {self.teach.name}: {turn.message}")
            self.power.reanchor(MAINS_V * statistics.fmean(x.current_a for x in event.after[-STEADY_CYCLES:]))
            return out
        if sig.direction > 0:
            pred = classify(sig, on_candidates(self.library, self.s), self.model)
            self.house.switched_on(sig, pred)
            self.library.add_live(sig, pred, self.s)
            row = self.faults.log(sig, pred, self.library, day_of(self.house.to_wall(sig.t_ms)))
            if row is not None and not row.unknown:
                summary = self.faults.health(row.label, self.library)
                if summary:
                    self.health.append({**summary, "t_ms": sig.t_ms})
            self.events.append((1, sig, pred))
            out.append(f"ON  {pred.label} p={pred.p:.2f} ({sig.step_va:+.0f} VA)")
        else:
            pred = classify(sig, off_candidates(self.house.on_list, self.library, self.s), self.model)
            removed = self.house.switched_off(sig, pred)
            self.events.append((-1, sig, pred))
            if removed is None:
                self.flags.append({"kind": "unexplained_off", "t_ms": sig.t_ms, "device": None,
                                   "value": None, "amount": abs(sig.step_va)})
            out.append(f"OFF {removed.label if removed else 'nothing matched'} ({sig.step_va:+.0f} VA)")
        self.power.reanchor(MAINS_V * statistics.fmean(x.current_a for x in event.after[-STEADY_CYCLES:]))
        for a in self.faults.check(self.library):
            self.flags.append({"kind": "fault", "t_ms": c.t_ms, "device": a.label, "value": a.value,
                               "amount": a.daily_mean})
            msg = f"{a.label}: {a.value} outside its normal range for {self.s.fault_days} days"
            self.alerts.append(msg)
            out.append("ALERT " + msg)
        out.append("state: " + self.house.summary())
        return out


def _lines(args):
    return from_serial(args.port) if args.port else from_file(args.input)


def cmd_record(args):
    for _ in record(from_serial(args.port), args.out):
        pass


def _steady_stretch(cycles, n=50):
    """The middle n cycles of the longest stretch with no gap."""
    best, cur = [], []
    for c in cycles:
        cur = [c] if c.gap_before else cur + [c]
        if len(cur) > len(best):
            best = cur
    mid = max(0, (len(best) - n) // 2)
    return best[mid:mid + n]


def cmd_calibrate(args):
    s = Settings.load(SETTINGS)
    s.threshold_a = calibrate(list(transform(from_file(args.input))))
    print(f"threshold_a = {s.threshold_a:.4f} A")
    if args.load:
        s.cycles_per_reading = measure_clock(_steady_stretch(list(transform(from_file(args.load)))))
        print(f"mains cycles per reading = {s.cycles_per_reading:.6f} (nominal {50 / 860:.6f})")
    s.save(SETTINGS)


def cmd_teach(args):
    s = Settings.load(SETTINGS)
    lib = Library.load(LIBRARY)
    session = TeachSession(args.name, s, args.setting, kind=args.kind, room=args.room)
    det = Detector(s.threshold_a)
    print(f"Registering '{args.name}': {session.target} turns. Each turn: switch it on, wait until it settles, "
          "switch it off. Nothing else should change. Ctrl+C to stop.")
    try:
        for c in transform(_lines(args)):
            event = det.feed(c)
            if event:
                print(session.add(extract(event, s), event).message)
                if session.ready or session.varies:
                    break
    except KeyboardInterrupt:
        pass
    if session.ready:
        lib.add_device(session.finish())
        lib.save(LIBRARY)
        print(f"saved '{args.name}' with {len(session.turns)} turns")
    else:
        print(f"not saved: {len(session.turns)} of {session.target} turns kept")


def cmd_run(args):
    s = Settings.load(SETTINGS)
    lib = Library.load(LIBRARY)
    pipe = Pipeline(s, lib, TimeeModel(), now_ms=None if args.input else lambda: int(time.time() * 1000))
    slm = None
    if args.slm:
        slm = Controller(pipe.house, LocalChatModel(args.slm), s)
        if args.input:   # replay: "now" is the replay's own time
            slm.now_ms = lambda: pipe.last_wall or 0
    try:
        for c in transform(_lines(args)):
            for msg in pipe.feed(c):
                print(msg, flush=True)
                if slm and msg.startswith("ALERT "):
                    slm.on_alert(msg[6:])
    except KeyboardInterrupt:
        pass
    lib.save(LIBRARY)


def _api():
    return os.environ.get("APEIRON_API", "http://127.0.0.1:5183")


def _db() -> Path:
    return Path(os.environ.get("APEIRON_DB", DEFAULT_DB)).resolve()


def _key_file() -> Path:
    return Path(os.environ.get("NILM_KEY_FILE", _db().parent / "nilm-gateway.key"))


def cmd_connect(args):
    from shp.gateway import connect
    owner_file = _db().parent / "owner.key"
    if not os.environ.get("APEIRON_OWNER_TOKEN") and not owner_file.exists():
        raise SystemExit(f"No owner key at {owner_file}. Start the backend once (npm run dev:nilm) to create it.")
    owner = os.environ.get("APEIRON_OWNER_TOKEN") or owner_file.read_text().strip()
    try:
        added = connect(_api(), owner, _key_file(), Library.load(LIBRARY))
    except OSError:
        raise SystemExit(f"The backend is not running at {_api()}. Start it first (npm run dev:nilm or npm run server).")
    print(f"connected; added: {', '.join(added) if added else 'nothing new'}")


def cmd_gateway(args):
    from shp.gateway import run
    s = Settings.load(SETTINGS)
    lib = Library.load(LIBRARY)
    faults = FaultMonitor.load(s, FAULTS)
    pipe = Pipeline(s, lib, TimeeModel(), faults=faults)          # live clock, also for a replay

    def save():
        lib.save(LIBRARY)
        faults.save(FAULTS)
    try:
        run(_lines(args), pipe, _api(), _key_file().read_text().strip(), replay=bool(args.input), save=save)
    except KeyboardInterrupt:
        pass
    save()


def main(argv=None):
    ap = argparse.ArgumentParser(prog="shp")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("record", "calibrate", "teach", "run", "gateway"):
        p = sub.add_parser(name)
        if name == "record":
            p.add_argument("--port", required=True)
        elif name == "calibrate":
            p.add_argument("--in", dest="input", required=True)
        else:
            src = p.add_mutually_exclusive_group(required=True)
            src.add_argument("--port")
            src.add_argument("--in", dest="input")
    sub.choices["record"].add_argument("--out", required=True)
    sub.choices["calibrate"].add_argument("--load")
    sub.choices["teach"].add_argument("--name", required=True)
    sub.choices["teach"].add_argument("--setting")
    sub.choices["teach"].add_argument("--kind", default="generic", help="how the app draws it, e.g. fridge, lights, ac")
    sub.choices["teach"].add_argument("--room", default="Living room",
                                      help="the room name, as you named it when you built your home in the app")
    sub.add_parser("connect", help="register the gateway, mains and taught devices with the app backend")
    sub.choices["run"].add_argument("--slm", nargs="?", const="http://localhost:8000",
                                    help="LM Studio server running lfm3-1.7b (default http://localhost:8000)")
    args = ap.parse_args(argv)
    {"record": cmd_record, "calibrate": cmd_calibrate, "teach": cmd_teach, "run": cmd_run,
     "connect": cmd_connect, "gateway": cmd_gateway}[args.cmd](args)


if __name__ == "__main__":
    main()
