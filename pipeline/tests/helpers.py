"""Hand-built inputs with known values, shared by the stage tests."""
import math

import numpy as np

from shp.extractor import Signature
from shp.settings import MAINS_V
from shp.transform import Cycle

CPR = 50.03 / 850   # true mains cycles per reading, ~1.2 % off nominal
RT2 = math.sqrt(2)


def wave(amp_a: float, phase_deg: float = 0.0, third: float = 0.0):
    """A device wave: main wave of amp_a RMS plus an optional third ripple (fraction of the main)."""
    ph = math.radians(phase_deg)
    return lambda t: RT2 * amp_a * (np.sin(t + ph) + third * np.sin(3 * (t + ph)))


def total(*fns):
    return lambda t: sum(f(t) for f in fns) if fns else 0 * t


def cycles_from(segments, noise=0.002, start=0, seed=0):
    """segments: [(n_cycles, wave function of mains angle)] -> back-to-back Cycles."""
    rng = np.random.default_rng(seed)
    out, j = [], start
    for n_cycles, fn in segments:
        for _ in range(n_cycles):
            k = 17 * j + np.arange(17)
            theta = 2 * math.pi * CPR * k + 0.7
            x = fn(theta) + rng.normal(0, noise, 17)
            out.append(Cycle(20 * j, 17 * j, tuple(float(v) for v in x)))
            j += 1
    return out


def shape(fn):
    theta = 2 * math.pi * np.arange(50) / 50
    w = fn(theta)
    return tuple(float(v) for v in w / np.sqrt(np.mean(w ** 2)))


def sig(step_va: float, steady=None, direction: int = 1, surge_peak: float = 2.0, settle_ms: int = 40,
        t_ms: int = 0, **flags) -> Signature:
    """A Signature with chosen values; the default shape is a plain sine."""
    steady = shape(np.sin) if steady is None else steady
    surge = tuple([surge_peak] + [1.0] * 49) if direction > 0 else ()
    step_a = direction * step_va / MAINS_V
    base = dict(clean=True, settled=True, shape_ok=True, low_trust=False, clock="before")
    base.update(flags)
    if not base["shape_ok"]:
        steady, surge = (), ()
    return Signature(direction, t_ms, steady, surge, abs(step_a) if steady else 0.0, step_a,
                     settle_ms, base["clean"], base["settled"], base["shape_ok"], base["low_trust"],
                     base["clock"])


class NearestModel:
    """Stand-in for TimEE with the same interface: nearest class centre, softmax over distances."""

    def __init__(self):
        self.calls = 0

    def predict(self, X_train, y_train, X_test):
        self.calls += 1
        labels = sorted(set(y_train.tolist()))
        centres = np.array([X_train[y_train == lab].mean(axis=0) for lab in labels])
        d = np.array([[np.sqrt(np.mean((x - c) ** 2)) for c in centres] for x in X_test])
        e = np.exp(-d / 0.02)
        probs = e / e.sum(axis=1, keepdims=True)
        return np.array([labels[i] for i in probs.argmax(axis=1)]), probs
