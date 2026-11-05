"""Measured and tunable numbers, saved in settings.json.

threshold_a and cycles_per_reading are measured by `calibrate`. The rest are design settings;
DESIGN.md says where each value comes from.
"""
import json
from dataclasses import asdict, dataclass, fields
from pathlib import Path

MAINS_V = 230                       # Ghana nominal; no voltage sensor
NOMINAL_CYCLES_PER_READING = 50 / 860


@dataclass
class Settings:
    threshold_a: float = 0.05                 # replace with `calibrate --in quiet.txt`
    cycles_per_reading: float | None = None   # from `calibrate --load lamp.txt`

    # 3 Signal extractor
    clock_min_level_mult: float = 5.0   # a window can give the clock if its current > 5 x threshold_a
    low_trust_ratio: float = 0.3        # |step| < 0.3 x before level -> low trust
    max_carry_cycles: int = 25          # clock carried from before over > 25 cycles -> low trust

    # 4 Library
    max_rounds: int = 8
    min_rounds: int = 3
    shape_floor: float = 0.1
    working_min_p: float = 0.9
    working_per_device: int = 20

    # 5 Classifier
    unknown_limit_floor: float = 0.1
    power_tolerance_frac: float = 0.10

    # 7 Power monitor
    drift_hold_s: int = 5
    step_within_s: int = 2
    drift_frac: float = 0.05

    # 8 Fault monitor
    fault_days: int = 3

    # 9 SLM control
    max_tool_rounds: int = 5

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(asdict(self), indent=2))

    @classmethod
    def load(cls, path: str | Path) -> "Settings":
        p = Path(path)
        if not p.exists():
            return cls()
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in json.loads(p.read_text()).items() if k in known})
