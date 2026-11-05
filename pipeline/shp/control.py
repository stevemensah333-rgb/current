"""Lets a small language model read the house state and act through three tools.

  switch_off(device)         the device must be on (by merged name); the user confirms first
  get_usage(device, period)  hours on and VA-hours from the house log
  notify_user(message)       shows or sends a message

The model is LFM3-1.7B (Liquid AI), served locally by LM Studio on an OpenAI-style endpoint.

The loop starts when the user asks something, or when an alert comes in. When an alert starts it,
the model may only call notify_user. At most max_tool_rounds rounds, then it stops.
"""
import json
import re
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Protocol

from shp.house import House
from shp.library import base_name
from shp.settings import Settings

MAX_OPEN_ALERTS = 10   # keeps the state line short for a small model
PERIOD_MS = {"hour": 3_600_000, "day": 86_400_000, "week": 7 * 86_400_000}

TOOLS = [
    {"type": "function", "function": {
        "name": "switch_off", "description": "Switch a device off. Only devices that are on can be switched off.",
        "parameters": {"type": "object", "properties": {"device": {"type": "string"}}, "required": ["device"]}}},
    {"type": "function", "function": {
        "name": "get_usage", "description": "Hours on and energy (VA-hours) of a device over a period.",
        "parameters": {"type": "object", "properties": {
            "device": {"type": "string"}, "period": {"type": "string", "enum": list(PERIOD_MS)}},
            "required": ["device", "period"]}}},
    {"type": "function", "function": {
        "name": "notify_user", "description": "Show a message to the user.",
        "parameters": {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}}},
]


class ChatModel(Protocol):
    def chat(self, messages: list[dict], tools: list[dict]) -> dict:
        """Returns {"content": str, "tool_calls": [{"id": str, "name": str, "arguments": dict}]}."""


class Switch(Protocol):
    def off(self, device: str) -> bool:
        """True if a switch is fitted and it switched the device off."""


class NoSwitch:
    """Until relays or smart plugs exist: log the request, switch nothing."""

    def __init__(self):
        self.requests: list[str] = []

    def off(self, device: str) -> bool:
        self.requests.append(device)
        return False


TOOL_CALL = re.compile(r"<tool_call>\s*<function=([^>]+)>(.*?)</function>\s*</tool_call>", re.S)
PARAMETER = re.compile(r"<parameter=([^>]+)>\s*(.*?)\s*</parameter>", re.S)


def parse_xml_tool_calls(text: str) -> list[dict]:
    """LFM3 writes tool calls as XML. LM Studio converts them; this reads them if a server does not.
    <tool_call><function=get_usage><parameter=device>kettle</parameter>...</function></tool_call>"""
    calls = []
    for i, (name, body) in enumerate(TOOL_CALL.findall(text)):
        calls.append({"id": f"call_{i}", "name": name.strip(),
                      "arguments": {k.strip(): v for k, v in PARAMETER.findall(body)}})
    return calls


class LocalChatModel:
    """A local server with an OpenAI-style chat endpoint running LFM3-1.7B.
    Defaults match LM Studio (`lms server start`, port 8000) and the model card's temperature 0.1."""

    def __init__(self, base_url: str = "http://localhost:8000", model: str = "lfm3-1.7b",
                 temperature: float = 0.1):
        self.url, self.model, self.temperature = base_url.rstrip("/") + "/v1/chat/completions", model, temperature

    def chat(self, messages, tools):
        body = json.dumps({"model": self.model, "messages": messages, "tools": tools,
                           "temperature": self.temperature}).encode()
        req = urllib.request.Request(self.url, body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=300) as r:
            msg = json.load(r)["choices"][0]["message"]
        content = msg.get("content") or ""
        calls = [{"id": c["id"], "name": c["function"]["name"],
                  "arguments": json.loads(c["function"]["arguments"] or "{}")}
                 for c in msg.get("tool_calls") or []]
        if not calls and "<tool_call>" in content:
            calls, content = parse_xml_tool_calls(content), TOOL_CALL.sub("", content).strip()
        return {"content": content, "tool_calls": calls}


@dataclass
class Controller:
    house: House
    model: ChatModel
    settings: Settings
    switch: Switch = field(default_factory=NoSwitch)
    confirm: Callable[[str], bool] = lambda device: False   # ask the user before switching off
    notify: Callable[[str], None] = print
    alerts: list[str] = field(default_factory=list)
    now_ms: Callable[[], int] = lambda: int(time.time() * 1000)

    def state_line(self) -> str:
        line = self.house.summary()
        return line + (" | alerts: " + "; ".join(self.alerts) if self.alerts else "")

    def acknowledge(self) -> None:
        """The user has seen the open alerts."""
        self.alerts.clear()

    def ask(self, request: str) -> str:
        return self._loop(request, allowed={"switch_off", "get_usage", "notify_user"})

    def on_alert(self, alert: str) -> str:
        self.alerts = (self.alerts + [alert])[-MAX_OPEN_ALERTS:]
        return self._loop(f"Alert: {alert}. Tell the user.", allowed={"notify_user"})

    def _loop(self, request: str, allowed: set[str]) -> str:
        tools = [t for t in TOOLS if t["function"]["name"] in allowed]
        messages = [{"role": "system", "content": "You manage a home's appliances. Current state: "
                     + self.state_line()},
                    {"role": "user", "content": request}]
        for _ in range(self.settings.max_tool_rounds):
            reply = self.model.chat(messages, tools)
            if not reply["tool_calls"]:
                return reply["content"]
            messages.append({"role": "assistant", "content": reply["content"], "tool_calls": [
                {"id": c["id"], "type": "function",
                 "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}}
                for c in reply["tool_calls"]]})
            for c in reply["tool_calls"]:
                result = self._run(c["name"], c["arguments"], allowed)
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": result})
        return f"Stopped after {self.settings.max_tool_rounds} tool rounds."

    def _run(self, name: str, args: dict, allowed: set[str]) -> str:
        if name not in allowed:
            return f"{name} is not allowed here"
        if name == "notify_user":
            self.notify(args.get("message", ""))
            return "shown"
        device = args.get("device", "")
        if name == "get_usage":
            span = PERIOD_MS.get(args.get("period", ""))
            if span is None:
                return "period must be hour, day or week"
            end = self.now_ms()
            hours, vah = self.house.usage(device, end - span, end)
            return f"{device}: {hours:.2f} h on, {vah:.0f} VAh in the last {args['period']}"
        if name == "switch_off":
            if not any(base_name(e.label) == device for e in self.house.on_list):
                return f"{device} is not on"
            if not self.confirm(device):
                return f"the user did not confirm switching off {device}"
            return f"{device} switched off" if self.switch.off(device) else f"no switch fitted for {device}"
        return f"unknown tool {name}"
