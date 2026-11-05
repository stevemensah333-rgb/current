"""Where the board's text lines come from: the live serial port or a saved session file.

Both give plain text lines, so a replayed file goes through the same transform() as live data.
"""
import time
from pathlib import Path
from typing import Iterable, Iterator

import serial


def from_file(path: str | Path) -> Iterator[str]:
    with open(path, encoding="ascii", errors="replace") as f:
        for line in f:
            yield line.rstrip("\r\n")


def from_serial(port: str, baud: int = 115200) -> Iterator[str]:
    """Reopens the port if the USB link drops."""
    while True:
        try:
            with serial.Serial(port, baud, timeout=2) as s:
                while True:
                    raw = s.readline()
                    if raw:
                        yield raw.decode("ascii", "replace").rstrip("\r\n")
        except serial.SerialException:
            time.sleep(1)


def record(lines: Iterable[str], path: str | Path) -> Iterator[str]:
    """Passes lines through unchanged while appending each one to path."""
    with open(path, "a", encoding="ascii", errors="replace", newline="\n") as f:
        for line in lines:
            f.write(line + "\n")
            f.flush()
            yield line
