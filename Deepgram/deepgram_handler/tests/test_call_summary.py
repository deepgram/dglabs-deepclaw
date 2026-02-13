# tests/test_call_summary.py
from unittest.mock import AsyncMock, patch

import pytest

from app.services.call_summary import (
    generate_call_summary,
    trim_call_entries,
)
from app.services.workspace import CallInfo, TranscriptEntry


# -- trim_call_entries --


def test_trim_call_entries_under_max():
    content = (
        "# Call History\n\n"
        "### 02/13/2026, 3:00 PM -- +15551234567 (inbound)\nFirst call.\n\n"
        "### 02/13/2026, 4:00 PM -- +15551234567 (inbound)\nSecond call.\n"
    )
    result = trim_call_entries(content, max_entries=5)
    assert result == content


def test_trim_call_entries_at_max():
    content = "# Call History\n\n### Entry 1\nSummary 1.\n\n### Entry 2\nSummary 2.\n"
    result = trim_call_entries(content, max_entries=2)
    assert "Entry 1" in result
    assert "Entry 2" in result


def test_trim_call_entries_over_max():
    content = (
        "# Call History\n\n"
        "### Entry 1\nOldest.\n\n"
        "### Entry 2\nMiddle.\n\n"
        "### Entry 3\nNewest.\n"
    )
    result = trim_call_entries(content, max_entries=2)
    assert "Entry 1" not in result
    assert "Entry 2" in result
    assert "Entry 3" in result
    assert result.startswith("# Call History")


def test_trim_call_entries_preserves_header():
    content = "# Call History\n\n### Entry 1\nOld.\n\n### Entry 2\nNew.\n"
    result = trim_call_entries(content, max_entries=1)
    assert result.startswith("# Call History")
    assert "Entry 1" not in result
    assert "Entry 2" in result


# -- generate_call_summary --


@pytest.mark.asyncio
async def test_generate_call_summary_appends_entry(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.workspace.WORKSPACE_DIR", tmp_path)

    # Pre-existing CALLS.md
    calls_path = tmp_path / "CALLS.md"
    calls_path.write_text(
        "# Call History\n\n### 02/12/2026, 1:00 PM -- +15550000000 (inbound)\nOld call.\n"
    )

    class FakeSettings:
        OPENCLAW_AGENT_ID = "main"
        ANTHROPIC_API_KEY = "test-key"
        TIMEZONE = "UTC"
        CALLS_MAX_ENTRIES = 50

    call_info = CallInfo(
        call_id="abc123",
        phone_number="+15551234567",
        direction="inbound",
        ended_at=1739480100.0,  # Known timestamp
        transcript=[
            TranscriptEntry(timestamp=1000.0, speaker="bot", text="Hello!"),
            TranscriptEntry(timestamp=1001.0, speaker="user", text="Hi there"),
        ],
    )

    with patch(
        "app.services.call_summary.call_anthropic", new_callable=AsyncMock
    ) as mock_llm:
        mock_llm.return_value = "Caller said hi. Brief greeting exchange."
        await generate_call_summary(FakeSettings(), call_info)

    content = calls_path.read_text()
    assert "Old call." in content
    assert "+15551234567 (inbound)" in content
    assert "Brief greeting exchange." in content
    # Verify LLM was called with transcript
    prompt_arg = mock_llm.call_args[0][1]
    assert "Hello!" in prompt_arg
    assert "Hi there" in prompt_arg


@pytest.mark.asyncio
async def test_generate_call_summary_creates_file_if_missing(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.workspace.WORKSPACE_DIR", tmp_path)

    class FakeSettings:
        OPENCLAW_AGENT_ID = "main"
        ANTHROPIC_API_KEY = "test-key"
        TIMEZONE = "UTC"
        CALLS_MAX_ENTRIES = 50

    call_info = CallInfo(
        call_id="abc123",
        phone_number="+15551234567",
        direction="inbound",
        ended_at=1739480100.0,
        transcript=[
            TranscriptEntry(timestamp=1000.0, speaker="user", text="Hey"),
        ],
    )

    with patch(
        "app.services.call_summary.call_anthropic", new_callable=AsyncMock
    ) as mock_llm:
        mock_llm.return_value = "Quick hello."
        await generate_call_summary(FakeSettings(), call_info)

    content = (tmp_path / "CALLS.md").read_text()
    assert content.startswith("# Call History")
    assert "Quick hello." in content


@pytest.mark.asyncio
async def test_generate_call_summary_skips_on_llm_failure(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.workspace.WORKSPACE_DIR", tmp_path)

    class FakeSettings:
        OPENCLAW_AGENT_ID = "main"
        ANTHROPIC_API_KEY = "test-key"
        TIMEZONE = "UTC"
        CALLS_MAX_ENTRIES = 50

    call_info = CallInfo(
        call_id="abc123",
        phone_number="+15551234567",
        direction="inbound",
        ended_at=1739480100.0,
        transcript=[
            TranscriptEntry(timestamp=1000.0, speaker="user", text="Hey"),
        ],
    )

    with patch(
        "app.services.call_summary.call_anthropic", new_callable=AsyncMock
    ) as mock_llm:
        mock_llm.return_value = None
        await generate_call_summary(FakeSettings(), call_info)

    # File should not be created
    assert not (tmp_path / "CALLS.md").exists()


@pytest.mark.asyncio
async def test_generate_call_summary_trims_to_max(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.workspace.WORKSPACE_DIR", tmp_path)

    # Create file with 3 existing entries
    entries = "# Call History\n\n"
    for i in range(3):
        entries += f"### Entry {i}\nSummary {i}.\n\n"

    calls_path = tmp_path / "CALLS.md"
    calls_path.write_text(entries)

    class FakeSettings:
        OPENCLAW_AGENT_ID = "main"
        ANTHROPIC_API_KEY = "test-key"
        TIMEZONE = "UTC"
        CALLS_MAX_ENTRIES = 2  # Only keep 2

    call_info = CallInfo(
        call_id="abc123",
        phone_number="+15551234567",
        direction="inbound",
        ended_at=1739480100.0,
        transcript=[
            TranscriptEntry(timestamp=1000.0, speaker="user", text="Hey"),
        ],
    )

    with patch(
        "app.services.call_summary.call_anthropic", new_callable=AsyncMock
    ) as mock_llm:
        mock_llm.return_value = "New call summary."
        await generate_call_summary(FakeSettings(), call_info)

    content = calls_path.read_text()
    # Only last 2 entries should remain (entry 2 + new one)
    assert "Entry 0" not in content
    assert "Entry 1" not in content
    assert "New call summary." in content
