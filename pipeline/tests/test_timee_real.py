"""The real TimEE model on signatures made by the real extractor.

Skipped when timee-ts is not installed. The first run downloads the model weights.
"""
import pytest

pytest.importorskip("timee")
pytestmark = pytest.mark.real

from helpers import cycles_from, wave                       # noqa: E402
from shp.classifier import TimeeModel, classify, on_candidates  # noqa: E402
from shp.detector import detect                             # noqa: E402
from shp.extractor import extract                           # noqa: E402
from shp.library import Library, TeachSession               # noqa: E402
from shp.settings import Settings                           # noqa: E402

S = Settings(threshold_a=0.05)
OFF = lambda t: 0 * t   # noqa: E731


# Three devices of the same size, so the power check cannot tell them apart; only the shape can.
def same_size(third):   # main wave scaled so every device is 4.0 A RMS
    return wave(4.0 / (1 + third ** 2) ** 0.5, third=third)


DEVICES = {
    "heater": same_size(0.0),    # plain sine
    "motor": same_size(0.25),    # strong third ripple
    "charger": same_size(0.6),   # very strong third ripple
}


def signatures(fn, rounds, seed):
    stream = cycles_from([(30, OFF), (120, fn), (60, OFF)] * rounds, seed=seed)
    return [extract(e, S) for e in detect(stream, S.threshold_a)]


@pytest.fixture(scope="module")
def library():
    lib = Library()
    for i, (name, fn) in enumerate(DEVICES.items()):
        session = TeachSession(name, S)
        for sig in signatures(fn, 4, seed=10 + i):
            session.add(sig)
        lib.add_device(session.finish())
    return lib


@pytest.fixture(scope="module")
def model():
    return TimeeModel(use_ensemble=False)


@pytest.mark.parametrize("name", list(DEVICES))
def test_timee_names_each_device_by_shape(library, model, name):
    new = next(s for s in signatures(DEVICES[name], 1, seed=99) if s.direction > 0)
    p = classify(new, on_candidates(library, S), model)
    assert p.source == "timee"
    assert p.label == name, p.ranked
