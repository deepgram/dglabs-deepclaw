"""Tests for SMS history logging to TEXTS.md."""

from unittest.mock import MagicMock, patch

from app.services.sms_history import (
    TEXTS_HEADER,
    _trim_entries,
    append_sms_entry,
)


def _mock_settings(tz: str = "UTC") -> MagicMock:
    s = MagicMock()
    s.TIMEZONE = tz
    s.OPENCLAW_AGENT_ID = "main"
    return s


def test_trim_entries_under_max():
    content = TEXTS_HEADER + "\n\n### 01/01/2026, 1:00 PM -- +1234 (sms)\nHello\n"
    result = _trim_entries(content, 5)
    assert result == content


def test_trim_entries_over_max():
    entries = ""
    for i in range(5):
        entries += f"\n\n### 01/0{i+1}/2026, 1:00 PM -- +1234 (sms)\nMessage {i}\n"
    content = TEXTS_HEADER + entries
    result = _trim_entries(content, 2)
    assert "Message 3" in result
    assert "Message 4" in result
    assert "Message 0" not in result
    assert "Message 1" not in result


def test_append_sms_entry_creates_file():
    """append_sms_entry should create TEXTS.md if it doesn't exist."""
    settings = _mock_settings()
    written_content = {}

    def fake_write(path, content):
        written_content["path"] = str(path)
        written_content["content"] = content

    with (
        patch("app.services.sms_history.read_workspace_file", return_value=None),
        patch("app.services.sms_history.write_workspace_file", side_effect=fake_write),
        patch("app.services.sms_history.workspace_path", return_value="/fake/TEXTS.md"),
    ):
        append_sms_entry(settings, "+15551234567", "Hey what's up?")

    assert written_content["content"].startswith(TEXTS_HEADER)
    assert "+15551234567 (sms)" in written_content["content"]
    assert "Hey what's up?" in written_content["content"]


def test_append_sms_entry_appends_to_existing():
    """append_sms_entry should append to existing TEXTS.md content."""
    settings = _mock_settings()
    existing = TEXTS_HEADER + "\n\n### 01/01/2026, 1:00 PM -- +15559999999 (sms)\nOld message\n"
    written_content = {}

    def fake_write(path, content):
        written_content["content"] = content

    with (
        patch("app.services.sms_history.read_workspace_file", return_value=existing),
        patch("app.services.sms_history.write_workspace_file", side_effect=fake_write),
        patch("app.services.sms_history.workspace_path", return_value="/fake/TEXTS.md"),
    ):
        append_sms_entry(settings, "+15551234567", "New message")

    assert "Old message" in written_content["content"]
    assert "New message" in written_content["content"]
    assert "+15551234567 (sms)" in written_content["content"]


def test_append_sms_entry_handles_exception():
    """append_sms_entry should not raise on errors."""
    settings = _mock_settings()

    with patch("app.services.sms_history.workspace_path", side_effect=RuntimeError("boom")):
        # Should not raise
        append_sms_entry(settings, "+15551234567", "Test")
