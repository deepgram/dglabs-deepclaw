import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.sms_context import FALLBACK_MESSAGE, HOLDING_MESSAGE

_NO_USER_MD = patch("app.services.sms_context.USER_MD_PATH", Path("/nonexistent/USER.md"))


@pytest.fixture
def client():
    return TestClient(app)


def test_proxy_inbound_sms_returns_reply(client):
    """Mock OpenClaw response, verify JSON reply."""
    with (
        patch("app.routers.proxy.ask_openclaw", AsyncMock(return_value="Hello from OpenClaw!")),
        _NO_USER_MD,
    ):
        response = client.post(
            "/proxy/inbound-sms",
            data={"From": "+15551234567", "Body": "hello", "MessageSid": "SM123"},
        )

    assert response.status_code == 200
    assert response.json() == {"reply": "Hello from OpenClaw!"}


def test_proxy_inbound_sms_openclaw_error_returns_fallback(client):
    """OpenClaw fails, verify fallback reply."""
    with patch("app.routers.proxy.ask_openclaw", AsyncMock(side_effect=Exception("connection refused"))):
        response = client.post(
            "/proxy/inbound-sms",
            data={"From": "+15551234567", "Body": "hello", "MessageSid": "SM123"},
        )

    assert response.status_code == 200
    assert response.json() == {"reply": FALLBACK_MESSAGE}


def test_proxy_inbound_mms_sends_multimodal_content(client):
    """Verify MMS with image passes multimodal content to ask_openclaw."""
    mock_ask = AsyncMock(return_value="Got your image!")
    fake_content = [
        {"type": "text", "text": "check this out"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,abc123"}},
    ]

    with (
        patch("app.routers.proxy.ask_openclaw", mock_ask),
        patch("app.routers.proxy.build_message_content", AsyncMock(return_value=fake_content)),
        _NO_USER_MD,
    ):
        response = client.post(
            "/proxy/inbound-sms",
            data={
                "From": "+15551234567",
                "Body": "check this out",
                "MessageSid": "SM456",
                "NumMedia": "1",
                "MediaUrl0": "https://api.twilio.com/media/img.jpg",
                "MediaContentType0": "image/jpeg",
            },
        )

    assert response.status_code == 200
    assert response.json() == {"reply": "Got your image!"}

    # Verify multimodal content was forwarded
    call_args = mock_ask.call_args
    assert call_args[0][2] is fake_content


def test_proxy_timeout_sends_holding_then_delayed(client):
    """When OpenClaw exceeds the reply timeout, return holding message and fire delayed reply."""

    async def _slow(*a, **kw):
        await asyncio.sleep(10)
        return "Late response"

    mock_delayed = AsyncMock()

    with (
        patch("app.routers.proxy.ask_openclaw", side_effect=_slow),
        patch("app.routers.proxy.TWILIO_REPLY_TIMEOUT", 0.01),
        patch("app.routers.proxy.send_delayed_reply", mock_delayed),
    ):
        response = client.post(
            "/proxy/inbound-sms",
            data={"From": "+15551234567", "Body": "long question", "MessageSid": "SM999"},
        )

    assert response.status_code == 200
    assert response.json() == {"reply": HOLDING_MESSAGE}
    mock_delayed.assert_called_once()
