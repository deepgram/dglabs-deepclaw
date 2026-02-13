import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_twilio_inbound_returns_twiml_with_stream(client):
    response = client.post(
        "/twilio/inbound",
        data={"CallSid": "CA123", "From": "+15551234567", "To": "+15559876543"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/xml"
    assert "<Connect>" in response.text
    assert "<Stream" in response.text
    assert "twilio/stream" in response.text


def test_twilio_outbound_returns_twiml_with_stream(client):
    response = client.post("/twilio/outbound?sid=outbound-abc123")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/xml"
    assert "<Connect>" in response.text
    assert "<Stream" in response.text
    assert "twilio/outbound-stream" in response.text
    assert "outbound-abc123" in response.text
    assert "<Parameter" in response.text


def test_twilio_outbound_no_sid(client):
    response = client.post("/twilio/outbound")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/xml"
    assert "twilio/outbound-stream" in response.text
