"""Tests for OpenClaw gateway WebSocket RPC helper."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.services.gateway import call_gateway


class FakeWebSocket:
    """Minimal fake WebSocket that records sent messages and returns scripted responses."""

    def __init__(self, responses: list[dict]):
        self._responses = [json.dumps(r) for r in responses]
        self._response_idx = 0
        self.sent: list[dict] = []

    async def send(self, data: str) -> None:
        self.sent.append(json.loads(data))

    async def recv(self) -> str:
        msg = self._responses[self._response_idx]
        self._response_idx += 1
        return msg

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


def _hello_ok(connect_id: str) -> dict:
    return {
        "type": "res",
        "id": connect_id,
        "ok": True,
        "payload": {"type": "hello-ok"},
    }


def _method_response(req_id: str, payload: dict) -> dict:
    return {
        "type": "res",
        "id": req_id,
        "ok": True,
        "payload": payload,
    }


def _method_error(req_id: str, message: str) -> dict:
    return {
        "type": "res",
        "id": req_id,
        "ok": False,
        "error": {"code": "error", "message": message},
    }


@pytest.mark.asyncio
async def test_call_gateway_sends_rpc():
    """Verify connect handshake + method call round-trip."""
    fake_ws = None

    def make_fake_ws(responses):
        nonlocal fake_ws
        fake_ws = FakeWebSocket(responses)
        return fake_ws

    # We need to intercept uuid generation to know the IDs ahead of time
    ids = iter(["connect-id-1", "request-id-1"])

    responses = [
        _hello_ok("connect-id-1"),
        _method_response("request-id-1", {"sessions": []}),
    ]

    with (
        patch("app.services.gateway.websockets.connect", return_value=FakeWebSocket(responses)) as mock_connect,
        patch("app.services.gateway.uuid.uuid4", side_effect=ids),
    ):
        result = await call_gateway(
            method="sessions.list",
            params={"spawnedBy": "agent:main:abc"},
            gateway_url="ws://localhost:18789",
            gateway_token="test-token",
        )

    assert result == {"sessions": []}

    # Verify websockets.connect was called with the right URL
    mock_connect.assert_called_once_with("ws://localhost:18789")

    # Get the fake_ws from the context manager
    ws = mock_connect.return_value
    assert len(ws.sent) == 2

    # First message: connect handshake
    connect_msg = ws.sent[0]
    assert connect_msg["type"] == "req"
    assert connect_msg["method"] == "connect"
    assert connect_msg["params"]["auth"]["token"] == "test-token"

    # Second message: method request
    method_msg = ws.sent[1]
    assert method_msg["type"] == "req"
    assert method_msg["method"] == "sessions.list"
    assert method_msg["params"]["spawnedBy"] == "agent:main:abc"


@pytest.mark.asyncio
async def test_call_gateway_returns_none_on_connection_error():
    with patch(
        "app.services.gateway.websockets.connect",
        side_effect=Exception("connection refused"),
    ):
        result = await call_gateway(
            method="sessions.list",
            params={},
            gateway_url="ws://localhost:18789",
            gateway_token="test-token",
        )

    assert result is None


@pytest.mark.asyncio
async def test_call_gateway_returns_none_on_method_error():
    ids = iter(["connect-id-2", "request-id-2"])

    responses = [
        _hello_ok("connect-id-2"),
        _method_error("request-id-2", "not found"),
    ]

    with (
        patch("app.services.gateway.websockets.connect", return_value=FakeWebSocket(responses)),
        patch("app.services.gateway.uuid.uuid4", side_effect=ids),
    ):
        result = await call_gateway(
            method="sessions.list",
            params={},
            gateway_url="ws://localhost:18789",
            gateway_token="test-token",
        )

    assert result is None


@pytest.mark.asyncio
async def test_call_gateway_skips_events():
    """Verify that intermediate events (like connect.challenge) are skipped."""
    ids = iter(["connect-id-3", "request-id-3"])

    responses = [
        # Server sends connect.challenge event before hello-ok
        {"type": "event", "event": "connect.challenge", "payload": {"nonce": "abc"}},
        _hello_ok("connect-id-3"),
        # Server sends tick event before method response
        {"type": "event", "event": "tick", "payload": {"ts": 12345}},
        _method_response("request-id-3", {"sessions": [{"key": "child:1"}]}),
    ]

    with (
        patch("app.services.gateway.websockets.connect", return_value=FakeWebSocket(responses)),
        patch("app.services.gateway.uuid.uuid4", side_effect=ids),
    ):
        result = await call_gateway(
            method="sessions.list",
            params={},
            gateway_url="ws://localhost:18789",
            gateway_token="test-token",
        )

    assert result == {"sessions": [{"key": "child:1"}]}


@pytest.mark.asyncio
async def test_call_gateway_returns_none_on_connect_failure():
    ids = iter(["connect-id-4"])

    responses = [
        {
            "type": "res",
            "id": "connect-id-4",
            "ok": False,
            "error": {"code": "auth_failed", "message": "bad token"},
        },
    ]

    with (
        patch("app.services.gateway.websockets.connect", return_value=FakeWebSocket(responses)),
        patch("app.services.gateway.uuid.uuid4", side_effect=ids),
    ):
        result = await call_gateway(
            method="sessions.list",
            params={},
            gateway_url="ws://localhost:18789",
            gateway_token="bad-token",
        )

    assert result is None
