"""SLM control with the real LFM3-1.7B model, served by LM Studio on localhost:8000.

Start it with:  lms server start   and   lms load lfm3-1.7b
Skipped when the server is not running.
"""
import json
import urllib.request

import pytest

from helpers import sig
from shp.classifier import Prediction
from shp.control import Controller, LocalChatModel, NoSwitch, parse_xml_tool_calls
from shp.house import House
from shp.settings import Settings

URL = "http://localhost:8000"


def test_xml_tool_calls_are_read():
    text = ("<tool_call>\n<function=get_usage>\n<parameter=device>\nkettle\n</parameter>\n"
            "<parameter=period>\nday\n</parameter>\n</function>\n</tool_call>")
    assert parse_xml_tool_calls(text) == [
        {"id": "call_0", "name": "get_usage", "arguments": {"device": "kettle", "period": "day"}}]


def _server_up() -> bool:
    try:
        with urllib.request.urlopen(URL + "/v1/models", timeout=2) as r:
            return any(m["id"] == "lfm3-1.7b" for m in json.load(r)["data"])
    except OSError:
        return False


def needs_server(f):
    skip = pytest.mark.skipif(not _server_up(), reason="LM Studio with lfm3-1.7b is not running")
    return pytest.mark.real(skip(f))


HOUR = 3_600_000


def house():
    h = House()
    h.switched_on(sig(2000, t_ms=0), Prediction("kettle", 0.94, (("kettle", 0.94),), True, "match"))
    h.switched_on(sig(150, t_ms=0), Prediction("fridge", 0.88, (("fridge", 0.88),), True, "match"))
    return h


@needs_server
def test_lfm3_answers_a_usage_question_with_the_tool():
    h = house()
    asked = []
    real_usage = h.usage
    h.usage = lambda name, a, b: asked.append(name) or real_usage(name, a, b)
    c = Controller(h, LocalChatModel(URL), Settings(), now_ms=lambda: HOUR)
    answer = c.ask("How long has the kettle been on in the last hour?")
    assert asked == ["kettle"]
    assert answer.strip()


@needs_server
def test_lfm3_switch_off_waits_for_the_user():
    sw = NoSwitch()
    c = Controller(house(), LocalChatModel(URL), Settings(), switch=sw, confirm=lambda d: False)
    c.ask("Switch the kettle off.")
    assert sw.requests == []          # the user did not confirm, so nothing was switched


@needs_server
def test_lfm3_alert_notifies_the_user():
    shown = []
    c = Controller(house(), LocalChatModel(URL), Settings(), notify=shown.append)
    c.on_alert("fridge: settle_ms outside its normal range for 3 days")
    assert shown and "fridge" in " ".join(shown).lower()
