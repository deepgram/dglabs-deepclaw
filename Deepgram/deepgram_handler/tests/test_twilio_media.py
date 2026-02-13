import base64
import json

from app.services.twilio_media import (
    extract_audio_from_media_event,
    build_media_event,
    build_clear_event,
    parse_twilio_event,
)


def test_parse_twilio_event_media():
    payload = base64.b64encode(b"\x00\x01\x02").decode()
    raw = json.dumps({"event": "media", "media": {"payload": payload}, "streamSid": "SM123"})
    result = parse_twilio_event(raw)
    assert result["event"] == "media"
    assert result["streamSid"] == "SM123"


def test_parse_twilio_event_start():
    raw = json.dumps({"event": "start", "start": {"callSid": "CA123", "streamSid": "SM123"}})
    result = parse_twilio_event(raw)
    assert result["event"] == "start"
    assert result["start"]["callSid"] == "CA123"


def test_parse_twilio_event_invalid_json():
    result = parse_twilio_event("not json")
    assert result is None


def test_extract_audio_from_media_event():
    audio = b"\xff\xd8\xff\xe0"
    payload = base64.b64encode(audio).decode()
    event = {"event": "media", "media": {"payload": payload}}
    result = extract_audio_from_media_event(event)
    assert result == audio


def test_extract_audio_from_media_event_missing_payload():
    event = {"event": "media", "media": {}}
    result = extract_audio_from_media_event(event)
    assert result is None


def test_build_media_event():
    audio = b"\x00\x01\x02\x03"
    result = build_media_event("SM123", audio)
    parsed = json.loads(result)
    assert parsed["event"] == "media"
    assert parsed["streamSid"] == "SM123"
    decoded = base64.b64decode(parsed["media"]["payload"])
    assert decoded == audio


def test_build_clear_event():
    result = build_clear_event("SM123")
    parsed = json.loads(result)
    assert parsed["event"] == "clear"
    assert parsed["streamSid"] == "SM123"
