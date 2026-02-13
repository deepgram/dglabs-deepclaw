from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


# ---------------------------------------------------------------------------
# POST /actions/send-sms
# ---------------------------------------------------------------------------


def test_action_send_sms_success(client):
    with patch(
        "app.routers.actions.send_sms",
        new_callable=AsyncMock,
        return_value={"sid": "SM123", "status": "queued"},
    ):
        resp = client.post(
            "/actions/send-sms",
            json={"to": "+15551234567", "body": "Hello!"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["sid"] == "SM123"


def test_action_send_sms_with_from_number(client):
    with patch(
        "app.routers.actions.send_sms",
        new_callable=AsyncMock,
        return_value={"sid": "SM456", "status": "queued"},
    ) as mock_send:
        resp = client.post(
            "/actions/send-sms",
            json={"to": "+15551234567", "body": "Hello!", "from_number": "+15559876543"},
        )

    assert resp.status_code == 200
    mock_send.assert_called_once_with(
        to="+15551234567", text="Hello!", from_number="+15559876543"
    )


def test_action_send_sms_no_proxy(client):
    with patch(
        "app.routers.actions.send_sms",
        new_callable=AsyncMock,
        side_effect=ValueError("TWILIO_PROXY_URL is not configured."),
    ):
        resp = client.post(
            "/actions/send-sms",
            json={"to": "+15551234567", "body": "Hello!"},
        )

    assert resp.status_code == 503
    assert resp.json()["ok"] is False


def test_action_send_sms_control_plane_error(client):
    with patch(
        "app.routers.actions.send_sms",
        new_callable=AsyncMock,
        side_effect=httpx.HTTPStatusError(
            "Bad Gateway",
            request=httpx.Request("POST", "http://test"),
            response=httpx.Response(502),
        ),
    ):
        resp = client.post(
            "/actions/send-sms",
            json={"to": "+15551234567", "body": "Hello!"},
        )

    assert resp.status_code == 502
    assert resp.json()["ok"] is False


def test_action_send_sms_missing_body(client):
    resp = client.post(
        "/actions/send-sms",
        json={"to": "+15551234567"},
    )
    assert resp.status_code == 422  # Validation error


# ---------------------------------------------------------------------------
# POST /actions/make-call
# ---------------------------------------------------------------------------


def test_action_make_call_success(client):
    with patch(
        "app.routers.actions.make_call",
        new_callable=AsyncMock,
        return_value={"sid": "CA123", "status": "queued", "session_id": "outbound-abc123"},
    ):
        resp = client.post(
            "/actions/make-call",
            json={"to": "+15551234567", "purpose": "Remind about meeting"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["sid"] == "CA123"
    assert data["session_id"] == "outbound-abc123"


def test_action_make_call_passes_correct_args(client):
    with patch(
        "app.routers.actions.make_call",
        new_callable=AsyncMock,
        return_value={"sid": "CA456", "status": "queued", "session_id": "outbound-def456"},
    ) as mock_call:
        resp = client.post(
            "/actions/make-call",
            json={"to": "+15551234567", "purpose": "Order pizza"},
        )

    assert resp.status_code == 200
    mock_call.assert_called_once_with(to="+15551234567", purpose="Order pizza")


def test_action_make_call_no_proxy(client):
    with patch(
        "app.routers.actions.make_call",
        new_callable=AsyncMock,
        side_effect=ValueError("TWILIO_PROXY_URL is not configured."),
    ):
        resp = client.post(
            "/actions/make-call",
            json={"to": "+15551234567", "purpose": "Should fail"},
        )

    assert resp.status_code == 503
    assert resp.json()["ok"] is False


def test_action_make_call_control_plane_error(client):
    with patch(
        "app.routers.actions.make_call",
        new_callable=AsyncMock,
        side_effect=httpx.HTTPStatusError(
            "Server Error",
            request=httpx.Request("POST", "http://test"),
            response=httpx.Response(500),
        ),
    ):
        resp = client.post(
            "/actions/make-call",
            json={"to": "+15551234567", "purpose": "Should fail"},
        )

    assert resp.status_code == 502
    assert resp.json()["ok"] is False


def test_action_make_call_missing_purpose(client):
    resp = client.post(
        "/actions/make-call",
        json={"to": "+15551234567"},
    )
    assert resp.status_code == 422  # Validation error
