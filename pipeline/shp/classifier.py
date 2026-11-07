"""Names the device in a Signature, or says "unknown".

  switch-on:  channels [steady, surge]; candidates = every device in the library
  switch-off: channels [steady];        candidates = devices on the on-list
  power check first, then TimEE (2+ candidates), a shape match score (1), or "unknown" (0).
"""
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from shp.extractor import Signature, shape_distance
from shp.library import DeviceEntry, Library
from shp.settings import MAINS_V, Settings

UNKNOWN = "unknown"
_columns_checked = False


class Model(Protocol):
    def predict(self, X_train, y_train, X_test): ...


class TimeeModel:
    """TimEE (pip install timee-ts), loaded on first use; the first call downloads the weights.
    Its probability columns follow the sorted labels (it uses a label encoder); classify() checks this once."""

    def __init__(self, use_ensemble: bool = True):
        self.use_ensemble = use_ensemble
        self._clf = None

    def predict(self, X_train, y_train, X_test):
        if self._clf is None:
            from timee import TimeeClassifier
            self._clf = TimeeClassifier.from_pretrained(use_ensemble=self.use_ensemble)
        return self._clf.predict(np.asarray(X_train, np.float32), np.asarray(y_train),
                                 np.asarray(X_test, np.float32))


@dataclass(frozen=True)
class Prediction:
    label: str                  # a device label, or "unknown"
    p: float
    ranked: tuple[tuple[str, float], ...]
    power_match: bool
    source: str                 # "timee", "match", "power", or "none" (nothing matched)
    matched: bool = True        # False: nothing matched. A matched "unknown" is an unknown on-list entry.
    nearest: str | None = None  # nearest device by shape, recorded even for unknown
    nearest_distance: float | None = None


@dataclass(frozen=True)
class Candidate:
    """One label the signature could be: its examples, typical step and step tolerance."""
    label: str
    examples: list[Signature]
    step_va: float
    tolerance: float
    shape_limit: float


def _tolerance(step_va: float, teach_half: float, settings: Settings) -> float:
    return max(teach_half, settings.power_tolerance_frac * step_va) + MAINS_V * settings.threshold_a


def on_candidates(library: Library, settings: Settings) -> list[Candidate]:
    out = []
    for d in library.devices:
        r = d.baseline.step_va
        out.append(Candidate(d.label, library.working_on(d), r.mean,
                             _tolerance(r.mean, r.high - r.mean, settings),
                             max(d.baseline.shape_limit, settings.unknown_limit_floor)))
    return out


def off_candidates(on_list, library: Library, settings: Settings) -> list[Candidate]:
    """One candidate per on-list entry, compared with that entry's own recorded step.
    A known device uses its on- and off-rounds; an unknown entry uses its own stored shape."""
    out = []
    for e in on_list:
        d = library.get(e.label)
        if d is not None:
            examples = library.working_on(d) + d.off_examples
            limit = max(d.baseline.shape_limit, settings.unknown_limit_floor)
            half = d.baseline.step_va.high - d.baseline.step_va.mean
        else:
            examples = [e.signature] if e.signature.shape_ok else []
            limit, half = settings.unknown_limit_floor, 0.0
        out.append(Candidate(e.label, examples, abs(e.step_va),
                             _tolerance(abs(e.step_va), half, settings), limit))
    return out


SPREAD_MARGIN = 1.5   # an appliance may vary 1.5 x as much as its own registered turns did


def _limit(c: Candidate) -> float:
    """How far a new switch may be from this appliance's examples and still be it, learned from the appliance
    itself: its turns differed by up to 0.32 (a laptop charger) -> 0.48 allowed; a steady kettle stays strict."""
    import itertools
    shapes = [ex.steady for ex in c.examples if ex.shape_ok]
    spread = max((shape_distance(a, b) for a, b in itertools.combinations(shapes, 2)), default=0.0)
    return max(c.shape_limit, SPREAD_MARGIN * spread)


def _channels(sig: Signature, with_surge: bool) -> list:
    return [sig.steady, sig.surge] if with_surge else [sig.steady]


def _nearest(sig: Signature, cands: list[Candidate]):
    best = None
    for c in cands:
        for ex in c.examples:
            if ex.shape_ok:
                d = shape_distance(sig.steady, ex.steady)
                if best is None or d < best[1]:
                    best = (c.label, d)
    return best or (None, None)


def classify(sig: Signature, cands: list[Candidate], model: Model) -> Prediction:
    nearest, nearest_d = _nearest(sig, cands) if sig.shape_ok else (None, None)

    def unknown(power_match=False, source="none"):
        return Prediction(UNKNOWN, 0.0, (), power_match, source, False, nearest, nearest_d)

    def by_power(cands, step):
        """Closest step wins; p = 1 - distance / tolerance; an exact tie is unknown."""
        ranked = sorted(cands, key=lambda c: abs(step - c.step_va))
        if len(ranked) > 1 and abs(step - ranked[0].step_va) == abs(step - ranked[1].step_va):
            return unknown(True, "power")
        scored = tuple((c.label, 1 - abs(step - c.step_va) / c.tolerance) for c in ranked)
        return Prediction(scored[0][0], scored[0][1], scored, True, "power", True, nearest, nearest_d)

    step = abs(sig.step_va)
    matched = [c for c in cands if abs(step - c.step_va) <= c.tolerance]
    if not matched:
        return unknown()

    # Two identical lamps give the same label twice; keep the closest step per label.
    by_label: dict[str, Candidate] = {}
    for c in matched:
        if c.label not in by_label or abs(step - c.step_va) < abs(step - by_label[c.label].step_va):
            by_label[c.label] = c
    matched = list(by_label.values())

    if not sig.shape_ok:
        return by_power(matched, step)

    with_surge = sig.direction > 0
    usable = [c for c in matched if any(ex.shape_ok for ex in c.examples)]
    if not usable:   # e.g. an unknown entry that switched on across a gap has no shape to compare
        return by_power(matched, step)

    def closest(c):
        return min(shape_distance(sig.steady, ex.steady) for ex in c.examples if ex.shape_ok)

    if len(usable) == 1:
        c = usable[0]
        d, limit = closest(c), _limit(c)
        if d > limit:
            # Switch-offs: a charger fading out after unplugging has an unreliable shape, but only something on the
            # list can switch off, so a power match names it.
            return by_power([c], step) if sig.direction < 0 else unknown(True)
        p = max(0.0, min(1.0, 1 - d / limit))
        return Prediction(c.label, p, ((c.label, p),), True, "match", True, nearest, nearest_d)

    X_train, y_train = [], []
    for c in usable:
        for ex in c.examples:
            if ex.shape_ok and (not with_surge or ex.surge):
                X_train.append(_channels(ex, with_surge))
                y_train.append(c.label)
    X_test = [_channels(sig, with_surge)]
    predicted, probs = model.predict(np.array(X_train), np.array(y_train), np.array(X_test))
    labels = sorted(set(y_train))
    ranked = tuple(sorted(zip(labels, (float(p) for p in probs[0])), key=lambda lp: -lp[1]))
    global _columns_checked
    if not _columns_checked:   # one-time check of the column order; later near-ties must not stop monitoring
        if str(predicted[0]) != ranked[0][0] and ranked[0][1] > (ranked[1][1] if len(ranked) > 1 else 0):
            raise RuntimeError("the model's probability columns do not follow the sorted labels; "
                               "fix the column mapping in classify()")
        _columns_checked = True
    winner = next(c for c in usable if c.label == ranked[0][0])
    if closest(winner) > _limit(winner):
        return by_power(matched, step) if sig.direction < 0 else unknown(True, "timee")
    return Prediction(ranked[0][0], ranked[0][1], ranked, True, "timee", True, nearest, nearest_d)
