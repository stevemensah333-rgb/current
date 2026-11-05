import math
from pathlib import Path

from shp.sources import from_file, record
from shp.transform import Cycle, check, parse_line, transform

DATA = Path(__file__).parent / "data"
READINGS = ",".join(["0.1"] * 17)


# Cycle

def test_current_and_peak_from_readings():
    c = Cycle(0, 0, (2.0, -2.0, 4.0, -4.0))
    assert math.isclose(c.current_a, math.sqrt(10))
    assert c.peak_a == 4.0


# parse_line

def test_parse_readings_line():
    assert parse_line(f"s,51234,867,{READINGS}") == Cycle(51234, 867, (0.1,) * 17)


def test_parse_skips_everything_else():
    for line in ["", "# board restarted", "ets Jun  8 2016 00:22:57",
                 "rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)",
                 "s,1060,51,0.001,0.210", f"s,abc,51,{READINGS}", f"s,1060,x,{READINGS}",
                 f"s,1060,51,{READINGS},0.1", f"s,1060,{READINGS}"]:
        assert parse_line(line) is None, line


# check

def test_check_normal_steps_have_no_gap():
    out = list(check([Cycle(0, 0, (0.1,)), Cycle(20, 17, (0.1,)), Cycle(40, 34, (0.1,))]))
    assert [c.gap_before for c in out] == [False, False, False]


def test_check_flags_missing_cycle():
    out = list(check([Cycle(0, 0, (0.1,)), Cycle(40, 34, (0.1,))]))
    assert out[1].gap_before


def test_check_flags_one_lost_reading():
    out = list(check([Cycle(0, 0, (0.1,)), Cycle(20, 18, (0.1,))]))
    assert out[1].gap_before


def test_check_flags_board_reset():
    out = list(check([Cycle(5000, 4250, (0.1,)), Cycle(300, 0, (0.1,))]))
    assert out[1].gap_before


# whole transformation on a saved session

def test_replay_small_session():
    cycles = list(transform(from_file(DATA / "session_small.txt")))
    assert [c.t_ms for c in cycles] == [1000, 1020, 1040, 1080, 300]
    # 1060 was cut off, so 1080 follows a gap; 300 follows a board restart
    assert [c.gap_before for c in cycles] == [False, False, False, True, True]
    assert all(len(c.readings) == 17 for c in cycles)


def test_record_saves_lines_unchanged(tmp_path):
    lines = list(from_file(DATA / "session_small.txt"))
    saved = tmp_path / "session.txt"
    assert list(record(lines, saved)) == lines
    assert list(from_file(saved)) == lines
