"""Twilio media stream protocol helpers.

Parse incoming WebSocket events from Twilio, extract audio payloads,
and build outgoing media/clear events.
"""

import base64
import json


def parse_twilio_event(raw: str) -> dict | None:
    """Parse a raw Twilio WebSocket message into a dict. Returns None on invalid JSON."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def extract_audio_from_media_event(event: dict) -> bytes | None:
    """Extract and base64-decode the audio payload from a Twilio media event."""
    payload = event.get("media", {}).get("payload", "")
    if not payload:
        return None
    return base64.b64decode(payload)


def build_media_event(stream_sid: str, audio: bytes) -> str:
    """Build a Twilio media event JSON string from raw audio bytes."""
    return json.dumps({
        "event": "media",
        "streamSid": stream_sid,
        "media": {"payload": base64.b64encode(audio).decode("ascii")},
    })


def build_clear_event(stream_sid: str) -> str:
    """Build a Twilio clear event JSON string for barge-in."""
    return json.dumps({
        "event": "clear",
        "streamSid": stream_sid,
    })
