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


SILENT_S = 5   # the board sends ~50 lines a second; 5 s of nothing means the USB link has stalled


def from_serial(port: str, baud: int = 115200, opener=serial.Serial, silent_s: float = SILENT_S) -> Iterator[str]:
    """Reopens the port if the USB link drops, or if the board goes silent: a stalled USB-serial chip can stay
    'connected' while passing no data, and only a fresh open (or a replug) brings it back."""
    while True:
        try:
            with opener(port, baud, timeout=1) as s:
                last = time.monotonic()
                while True:
                    raw = s.readline()
                    if raw:
                        last = time.monotonic()
                        yield raw.decode("ascii", "replace").rstrip("\r\n")
                    elif time.monotonic() - last > silent_s:
                        print(f"[serial] no data from {port} for {silent_s:.0f} s; reopening", flush=True)
                        break
        except serial.SerialException:
            pass
        time.sleep(1)


def record(lines: Iterable[str], path: str | Path) -> Iterator[str]:
    """Passes lines through unchanged while appending each one to path."""
    with open(path, "a", encoding="ascii", errors="replace", newline="\n") as f:
        for line in lines:
            f.write(line + "\n")
            f.flush()
            yield line
