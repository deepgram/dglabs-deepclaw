# Post-Call Extraction Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add post-call extraction to the Python Deepgram sidecar — after each inbound voice call, extract a call summary (CALLS.md), user profile (USER.md), and agent identity (IDENTITY.md) using Claude Sonnet via the Anthropic API.

**Architecture:** Three standalone async service modules in `app/services/`, triggered concurrently from the `run_agent_bridge()` finally block. Each calls the Anthropic Messages API directly, parses/merges results with existing workspace markdown files, and writes back. Transcript is captured during the bridge session from Deepgram `ConversationText` events.

**Tech Stack:** Python 3.12, FastAPI, httpx, pydantic-settings, pytest + pytest-asyncio

**Test runner:** `cd Deepgram/deepgram_handler && uv run pytest tests/ -v`

**Design doc:** `docs/plans/2026-02-13-post-call-extraction-design.md`

---

## Task 1: Shared Workspace Module

Shared helpers for path resolution, file I/O, transcript formatting, Anthropic API calls, and JSON response parsing. Every subsequent task depends on this.

**Files:**

- Create: `Deepgram/deepgram_handler/app/services/workspace.py`
- Create: `Deepgram/deepgram_handler/tests/test_workspace.py`

### Step 1: Write the failing tests

````python
# tests/test_workspace.py
import json
import time
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.services.workspace import (
    CallInfo,
    TranscriptEntry,
    call_anthropic,
    format_transcript,
    parse_json_response,
    read_workspace_file,
    workspace_path,
    write_workspace_file,
)


# -- TranscriptEntry & format_transcript --

def test_format_transcript_basic():
    entries = [
        TranscriptEntry(timestamp=1000.0, speaker="bot", text="Hello!"),
        TranscriptEntry(timestamp=1001.0, speaker="user", text="Hi, how are you?"),
        TranscriptEntry(timestamp=1002.0, speaker="bot", text="I'm great, thanks!"),
    ]
    result = format_transcript(entries)
    assert result == "Agent: Hello!\nCaller: Hi, how are you?\nAgent: I'm great, thanks!"


def test_format_transcript_empty():
    assert format_transcript([]) == ""


# -- workspace_path --

def test_workspace_path_main_agent(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.workspace.WORKSPACE_DIR", tmp_path)

    class FakeSettings:
        OPENCLAW_AGENT_ID = "main"

    assert workspace_path(FakeSettings(), "USER.md") == tmp_path / "USER.md"


def test_workspace_path_sub_agent(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.workspace.WORKSPACE_DIR", tmp_path)

    class FakeSettings:
        OPENCLAW_AGENT_ID = "voice-agent"

    assert workspace_path(FakeSettings(), "USER.md") == tmp_path / "voice-agent" / "USER.md"


# -- read_workspace_file / write_workspace_file --

def test_read_workspace_file_exists(tmp_path):
    f = tmp_path / "TEST.md"
    f.write_text("hello world")
    assert read_workspace_file(f) == "hello world"


def test_read_workspace_file_missing(tmp_path):
    assert read_workspace_file(tmp_path / "NOPE.md") is None


def test_read_workspace_file_empty(tmp_path):
    f = tmp_path / "EMPTY.md"
    f.write_text("   \n  ")
    assert read_workspace_file(f) is None


def test_write_workspace_file_creates_dirs(tmp_path):
    f = tmp_path / "sub" / "dir" / "FILE.md"
    write_workspace_file(f, "content here")
    assert f.read_text() == "content here"


# -- parse_json_response --

def test_parse_json_response_plain():
    result = parse_json_response('{"name": "Bill"}')
    assert result == {"name": "Bill"}


def test_parse_json_response_code_fence():
    raw = '```json\n{"name": "Bill"}\n```'
    result = parse_json_response(raw)
    assert result == {"name": "Bill"}


def test_parse_json_response_code_fence_no_lang():
    raw = '```\n{"name": "Bill"}\n```'
    result = parse_json_response(raw)
    assert result == {"name": "Bill"}


def test_parse_json_response_invalid():
    assert parse_json_response("not json at all") is None


def test_parse_json_response_empty():
    assert parse_json_response("") is None


# -- call_anthropic --

@pytest.mark.asyncio
async def test_call_anthropic_success():
    mock_response = httpx.Response(
        200,
        json={"content": [{"type": "text", "text": "Summary here."}]},
        request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.workspace.httpx.AsyncClient", return_value=mock_client):
        result = await call_anthropic("test-key", "Extract info", "You are helpful")

    assert result == "Summary here."
    call_kwargs = mock_client.post.call_args[1]
    assert call_kwargs["headers"]["x-api-key"] == "test-key"
    body = call_kwargs["json"]
    assert body["model"] == "claude-sonnet-4-5-20250929"
    assert body["messages"][0]["content"] == "Extract info"
    assert body["system"] == "You are helpful"


@pytest.mark.asyncio
async def test_call_anthropic_empty_key():
    result = await call_anthropic("", "prompt", "system")
    assert result is None


@pytest.mark.asyncio
async def test_call_anthropic_http_error():
    mock_response = httpx.Response(
        500,
        json={"error": "internal"},
        request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.workspace.httpx.AsyncClient", return_value=mock_client):
        result = await call_anthropic("test-key", "prompt", "system")

    assert result is None


@pytest.mark.asyncio
async def test_call_anthropic_network_error():
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(side_effect=httpx.ConnectError("refused"))

    with patch("app.services.workspace.httpx.AsyncClient", return_value=mock_client):
        result = await call_anthropic("test-key", "prompt", "system")

    assert result is None
````

### Step 2: Run tests to verify they fail

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/test_workspace.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.workspace'`

### Step 3: Write the implementation

````python
# app/services/workspace.py
"""Shared helpers for post-call extraction pipeline.

Path resolution, file I/O, transcript formatting, Anthropic API calls,
and JSON response parsing.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

WORKSPACE_DIR = Path.home() / ".openclaw" / "workspace"
SONNET_MODEL = "claude-sonnet-4-5-20250929"
API_URL = "https://api.anthropic.com/v1/messages"
TIMEOUT_S = 30.0
MAX_TOKENS = 1024


@dataclass
class TranscriptEntry:
    timestamp: float
    speaker: str  # "bot" | "user"
    text: str


@dataclass
class CallInfo:
    call_id: str
    phone_number: str
    direction: str  # "inbound" | "outbound"
    ended_at: float
    transcript: list[TranscriptEntry]


def format_transcript(transcript: list[TranscriptEntry]) -> str:
    """Format transcript entries as 'Agent: .../Caller: ...' dialogue."""
    lines = []
    for entry in transcript:
        label = "Agent" if entry.speaker == "bot" else "Caller"
        lines.append(f"{label}: {entry.text}")
    return "\n".join(lines)


def workspace_path(settings, filename: str) -> Path:
    """Resolve a workspace file path for the configured agent."""
    base = WORKSPACE_DIR
    if settings.OPENCLAW_AGENT_ID != "main":
        base = base / settings.OPENCLAW_AGENT_ID
    return base / filename


def read_workspace_file(path: Path) -> str | None:
    """Read a workspace file. Returns None if missing or empty."""
    try:
        content = path.read_text().strip()
        return content or None
    except (FileNotFoundError, PermissionError):
        return None


def write_workspace_file(path: Path, content: str) -> None:
    """Write a workspace file, creating parent directories."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def parse_json_response(raw: str) -> dict | None:
    """Parse a JSON response, stripping code fences if present."""
    if not raw or not raw.strip():
        return None
    text = raw.strip()
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence_match:
        text = fence_match.group(1).strip()
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        logger.warning("Failed to parse JSON response: %s", text[:200])
        return None


async def call_anthropic(
    api_key: str,
    prompt: str,
    system_prompt: str,
    max_tokens: int = MAX_TOKENS,
) -> str | None:
    """Call Claude Sonnet via the Anthropic Messages API.

    Returns the text response, or None on any failure.
    """
    if not api_key:
        return None

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                API_URL,
                headers={
                    "Content-Type": "application/json",
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                },
                json={
                    "model": SONNET_MODEL,
                    "max_tokens": max_tokens,
                    "system": system_prompt,
                    "messages": [{"role": "user", "content": prompt}],
                },
                timeout=TIMEOUT_S,
            )

            if resp.status_code != 200:
                logger.warning("Anthropic API returned %d", resp.status_code)
                return None

            data = resp.json()
            content = data.get("content", [])
            if not content:
                return None

            text = content[0].get("text", "").strip()
            return text or None

    except Exception:
        logger.debug("Anthropic API call failed", exc_info=True)
        return None
````

### Step 4: Run tests to verify they pass

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/test_workspace.py -v`
Expected: All PASS

### Step 5: Commit

```bash
cd Deepgram/deepgram_handler
git add app/services/workspace.py tests/test_workspace.py
git commit -m "feat(sidecar): add shared workspace module for post-call extraction"
```

---

## Task 2: Call Summary Extraction (CALLS.md)

Extracts a plain-text call summary via Sonnet, appends it to CALLS.md with timestamp, and trims to max entries.

**Files:**

- Create: `Deepgram/deepgram_handler/app/services/call_summary.py`
- Create: `Deepgram/deepgram_handler/tests/test_call_summary.py`

### Step 1: Write the failing tests

```python
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
    content = (
        "# Call History\n\n"
        "### Entry 1\nSummary 1.\n\n"
        "### Entry 2\nSummary 2.\n"
    )
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
    content = (
        "# Call History\n\n"
        "### Entry 1\nOld.\n\n"
        "### Entry 2\nNew.\n"
    )
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
    calls_path.write_text("# Call History\n\n### 02/12/2026, 1:00 PM -- +15550000000 (inbound)\nOld call.\n")

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

    with patch("app.services.call_summary.call_anthropic", new_callable=AsyncMock) as mock_llm:
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

    with patch("app.services.call_summary.call_anthropic", new_callable=AsyncMock) as mock_llm:
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

    with patch("app.services.call_summary.call_anthropic", new_callable=AsyncMock) as mock_llm:
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

    with patch("app.services.call_summary.call_anthropic", new_callable=AsyncMock) as mock_llm:
        mock_llm.return_value = "New call summary."
        await generate_call_summary(FakeSettings(), call_info)

    content = calls_path.read_text()
    # Only last 2 entries should remain (entry 2 + new one)
    assert "Entry 0" not in content
    assert "Entry 1" not in content
    assert "New call summary." in content
```

### Step 2: Run tests to verify they fail

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/test_call_summary.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.call_summary'`

### Step 3: Write the implementation

```python
# app/services/call_summary.py
"""Post-call summary extraction — appends entries to CALLS.md.

After each inbound call, summarizes the conversation via Claude Sonnet
and appends a timestamped entry to the agent's CALLS.md file.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from app.services.workspace import (
    CallInfo,
    call_anthropic,
    format_transcript,
    read_workspace_file,
    workspace_path,
    write_workspace_file,
)

logger = logging.getLogger(__name__)

SUMMARY_SYSTEM_PROMPT = (
    "Summarize this phone call concisely. Include: who called, what was discussed, "
    "any specific requests or topics, any action items or outcomes, and anything the "
    "caller might appreciate being remembered next time. Write plain text only."
)


def trim_call_entries(content: str, max_entries: int) -> str:
    """Keep the header and the last N call entries."""
    parts = re.split(r"(?=^### )", content, flags=re.MULTILINE)
    header = parts[0] if parts else "# Call History\n\n"
    entries = parts[1:]

    if len(entries) <= max_entries:
        return content

    kept = entries[-max_entries:]
    return header.rstrip() + "\n\n" + "".join(kept).rstrip() + "\n"


def _format_timestamp(ended_at: float, tz_name: str) -> str:
    """Format a timestamp for CALLS.md entry heading."""
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(tz_name)
    except (ImportError, KeyError):
        tz = timezone.utc

    dt = datetime.fromtimestamp(ended_at, tz=tz)
    return dt.strftime("%m/%d/%Y, %-I:%M %p")


async def generate_call_summary(settings, call_info: CallInfo) -> None:
    """Extract a call summary and append it to CALLS.md."""
    try:
        transcript_text = format_transcript(call_info.transcript)
        if not transcript_text:
            return

        prompt = (
            f"Summarize this phone call concisely.\n"
            f"Include: who called, what was discussed, any specific requests or topics (name them),\n"
            f"any action items or outcomes, and anything the caller might appreciate being remembered next time.\n"
            f"Write plain text only -- no markdown formatting, no bullet points.\n\n"
            f"Call direction: {call_info.direction}\n"
            f"Phone number: {call_info.phone_number}\n\n"
            f"Transcript:\n{transcript_text}"
        )

        summary = await call_anthropic(
            settings.ANTHROPIC_API_KEY,
            prompt,
            SUMMARY_SYSTEM_PROMPT,
            max_tokens=500,
        )

        if not summary:
            logger.warning("[post-call] Call summary extraction returned no result")
            return

        calls_path = workspace_path(settings, "CALLS.md")
        existing = read_workspace_file(calls_path) or "# Call History\n"

        timestamp = _format_timestamp(call_info.ended_at, settings.TIMEZONE)
        entry = f"### {timestamp} -- {call_info.phone_number} ({call_info.direction})\n{summary}\n"
        updated = existing.rstrip() + "\n\n" + entry

        trimmed = trim_call_entries(updated, settings.CALLS_MAX_ENTRIES)
        write_workspace_file(calls_path, trimmed)

        logger.info("[post-call] Call summary written to CALLS.md")

    except Exception:
        logger.exception("[post-call] Failed to generate call summary")
```

### Step 4: Run tests to verify they pass

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/test_call_summary.py -v`
Expected: All PASS

### Step 5: Commit

```bash
cd Deepgram/deepgram_handler
git add app/services/call_summary.py tests/test_call_summary.py
git commit -m "feat(sidecar): add call summary extraction for CALLS.md"
```

---

## Task 3: User Profile Extraction (USER.md)

Parses USER.md markdown, extracts profile fields from transcript via Sonnet, merges with fill-only semantics, and writes back.

**Files:**

- Create: `Deepgram/deepgram_handler/app/services/user_profile.py`
- Create: `Deepgram/deepgram_handler/tests/test_user_profile.py`

### Step 1: Write the failing tests

```python
# tests/test_user_profile.py
from unittest.mock import AsyncMock, patch

import pytest

from app.services.user_profile import (
    USER_PLACEHOLDERS,
    UserProfile,
    extract_user_profile,
    is_placeholder,
    merge_user_profiles,
    normalize_value,
    parse_user_md,
    serialize_user_md,
)
from app.services.workspace import CallInfo, TranscriptEntry


# -- normalize_value --

def test_normalize_strips_markdown():
    assert normalize_value("**hello**") == "hello"
    assert normalize_value("_world_") == "world"


def test_normalize_strips_parens():
    assert normalize_value("(optional)") == "optional"


def test_normalize_lowercases():
    assert normalize_value("America/New_York") == "america/new_york"


def test_normalize_collapses_whitespace():
    assert normalize_value("  lots   of   space  ") == "lots of space"


def test_normalize_em_dash():
    assert normalize_value("one\u2014two") == "one-two"


# -- is_placeholder --

def test_is_placeholder_true():
    assert is_placeholder("_(optional)_") is True
    assert is_placeholder("(optional)") is True


def test_is_placeholder_context_placeholder():
    val = "_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_"
    assert is_placeholder(val) is True


def test_is_placeholder_false():
    assert is_placeholder("Bill Getman") is False
    assert is_placeholder("America/New_York") is False


# -- parse_user_md --

def test_parse_user_md_full():
    content = (
        "# USER.md - About Your Human\n\n"
        "_Learn about the person you're helping._\n\n"
        "- **Name:** Bill Getman\n"
        "- **What to call them:** Bill\n"
        "- **Pronouns:** he/him\n"
        "- **Timezone:** America/New_York\n"
        "- **Notes:** Works at Deepgram\n\n"
        "## Context\n\n"
        "Working on voice AI.\n\n"
        "---\n\n"
        "Footer text.\n"
    )
    p = parse_user_md(content)
    assert p.name == "Bill Getman"
    assert p.call_name == "Bill"
    assert p.pronouns == "he/him"
    assert p.timezone == "America/New_York"
    assert p.notes == "Works at Deepgram"
    assert p.context == "Working on voice AI."


def test_parse_user_md_empty_template():
    content = (
        "# USER.md - About Your Human\n\n"
        "- **Name:**\n"
        "- **What to call them:**\n"
        "- **Pronouns:** _(optional)_\n"
        "- **Timezone:**\n"
        "- **Notes:**\n\n"
        "## Context\n\n"
        "_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_\n"
    )
    p = parse_user_md(content)
    assert p.name is None
    assert p.call_name is None
    assert p.pronouns is None
    assert p.timezone is None
    assert p.notes is None
    assert p.context is None


def test_parse_user_md_with_frontmatter():
    content = (
        "---\nsummary: test\n---\n\n"
        "# USER.md - About Your Human\n\n"
        "- **Name:** Alice\n"
        "- **What to call them:** Al\n"
        "- **Pronouns:**\n"
        "- **Timezone:**\n"
        "- **Notes:**\n\n"
        "## Context\n\n"
        "Likes cats.\n"
    )
    p = parse_user_md(content)
    assert p.name == "Alice"
    assert p.call_name == "Al"
    assert p.context == "Likes cats."


# -- merge_user_profiles --

def test_merge_fills_empty_fields():
    existing = UserProfile()
    extracted = UserProfile(name="Bill", call_name="Bill", timezone="UTC")
    merged = merge_user_profiles(existing, extracted)
    assert merged.name == "Bill"
    assert merged.call_name == "Bill"
    assert merged.timezone == "UTC"


def test_merge_does_not_overwrite():
    existing = UserProfile(name="Bill", timezone="America/New_York")
    extracted = UserProfile(name="William", timezone="UTC", notes="New info")
    merged = merge_user_profiles(existing, extracted)
    assert merged.name == "Bill"  # Not overwritten
    assert merged.timezone == "America/New_York"  # Not overwritten
    assert merged.notes == "New info"  # Filled


def test_merge_context_appends():
    existing = UserProfile(context="Likes voice AI.")
    extracted = UserProfile(context="Working on DeepClaw.")
    merged = merge_user_profiles(existing, extracted)
    assert "Likes voice AI." in merged.context
    assert "Working on DeepClaw." in merged.context


def test_merge_context_deduplicates():
    existing = UserProfile(context="Likes voice AI.")
    extracted = UserProfile(context="Likes voice AI.")
    merged = merge_user_profiles(existing, extracted)
    assert merged.context == "Likes voice AI."


def test_merge_context_fills_empty():
    existing = UserProfile()
    extracted = UserProfile(context="New context.")
    merged = merge_user_profiles(existing, extracted)
    assert merged.context == "New context."


# -- serialize_user_md --

def test_serialize_roundtrip():
    profile = UserProfile(
        name="Bill Getman",
        call_name="Bill",
        pronouns="he/him",
        timezone="America/New_York",
        notes="Works at Deepgram",
        context="Working on voice AI.",
    )
    md = serialize_user_md(profile)
    parsed = parse_user_md(md)
    assert parsed.name == "Bill Getman"
    assert parsed.call_name == "Bill"
    assert parsed.pronouns == "he/him"
    assert parsed.timezone == "America/New_York"
    assert parsed.notes == "Works at Deepgram"
    assert parsed.context == "Working on voice AI."


def test_serialize_empty_profile():
    md = serialize_user_md(UserProfile())
    assert "**Name:**" in md
    assert "## Context" in md


# -- extract_user_profile (integration) --

@pytest.mark.asyncio
async def test_extract_user_profile_fills_empty(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.workspace.WORKSPACE_DIR", tmp_path)

    # Write empty template
    user_path = tmp_path / "USER.md"
    user_path.write_text(
        "# USER.md - About Your Human\n\n"
        "- **Name:**\n"
        "- **What to call them:**\n"
        "- **Pronouns:** _(optional)_\n"
        "- **Timezone:**\n"
        "- **Notes:**\n\n"
        "## Context\n\n---\n"
    )

    class FakeSettings:
        OPENCLAW_AGENT_ID = "main"
        ANTHROPIC_API_KEY = "test-key"

    call_info = CallInfo(
        call_id="abc123",
        phone_number="+15551234567",
        direction="inbound",
        ended_at=1739480100.0,
        transcript=[
            TranscriptEntry(1000.0, "bot", "What's your name?"),
            TranscriptEntry(1001.0, "user", "I'm Bill, you can call me Bill."),
        ],
    )

    with patch("app.services.user_profile.call_anthropic", new_callable=AsyncMock) as mock_llm:
        mock_llm.return_value = '{"name": "Bill", "callName": "Bill"}'
        await extract_user_profile(FakeSettings(), call_info)

    content = user_path.read_text()
    assert "Bill" in content


@pytest.mark.asyncio
async def test_extract_user_profile_skips_when_populated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.workspace.WORKSPACE_DIR", tmp_path)

    user_path = tmp_path / "USER.md"
    user_path.write_text(
        "# USER.md - About Your Human\n\n"
        "- **Name:** Bill\n"
        "- **What to call them:** Bill\n"
        "- **Pronouns:**\n"
        "- **Timezone:** UTC\n"
        "- **Notes:** Likes coffee\n\n"
        "## Context\n\nVoice AI work.\n"
    )

    class FakeSettings:
        OPENCLAW_AGENT_ID = "main"
        ANTHROPIC_API_KEY = "test-key"

    call_info = CallInfo(
        call_id="abc123",
        phone_number="+15551234567",
        direction="inbound",
        ended_at=1739480100.0,
        transcript=[
            TranscriptEntry(1000.0, "user", "Hey"),
        ],
    )

    with patch("app.services.user_profile.call_anthropic", new_callable=AsyncMock) as mock_llm:
        await extract_user_profile(FakeSettings(), call_info)

    # LLM should not have been called — all key fields populated
    mock_llm.assert_not_called()
```

### Step 2: Run tests to verify they fail

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/test_user_profile.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.user_profile'`

### Step 3: Write the implementation

```python
# app/services/user_profile.py
"""Post-call user profile extraction — merges into USER.md.

After each inbound call, extracts user profile fields from the transcript
via Claude Sonnet and merges them into the agent's USER.md with fill-only
semantics (never overwrites existing values).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

from app.services.workspace import (
    CallInfo,
    call_anthropic,
    format_transcript,
    parse_json_response,
    read_workspace_file,
    workspace_path,
    write_workspace_file,
)

logger = logging.getLogger(__name__)

USER_PLACEHOLDERS = {
    "optional",
    "what do they care about? what projects are they working on? what annoys them? what makes them laugh? build this over time.",
}

PROFILE_SYSTEM_PROMPT = (
    "Extract user profile information from this phone call transcript. "
    "Return ONLY a JSON object with the fields you can confidently extract. "
    "Do NOT guess or infer values not in the conversation. Return valid JSON only."
)

PROFILE_PROMPT_TEMPLATE = (
    "Extract user profile information from this phone call transcript.\n"
    "Return ONLY a JSON object with fields you can confidently extract from the conversation.\n\n"
    "Fields:\n"
    '- "name": Their full name if stated\n'
    '- "callName": What they prefer to be called (first name, nickname -- whatever they used)\n'
    '- "pronouns": If mentioned or clearly implied\n'
    '- "timezone": Only if explicitly stated or strongly implied by context\n'
    '- "notes": Quick facts worth remembering (job, family members mentioned, preferences)\n'
    '- "context": What they care about -- projects, interests, what they called about (1-2 sentences)\n\n'
    "Only include fields supported by clear evidence in the transcript.\n"
    "Do NOT guess or infer values not in the conversation.\n"
    "Return valid JSON only, no markdown.\n\n"
    "Transcript:\n{transcript}"
)


@dataclass
class UserProfile:
    name: str | None = None
    call_name: str | None = None
    pronouns: str | None = None
    timezone: str | None = None
    notes: str | None = None
    context: str | None = None


def normalize_value(value: str) -> str:
    """Normalize a value for placeholder comparison."""
    n = value.strip()
    n = re.sub(r"^[*_]+|[*_]+$", "", n).strip()
    if n.startswith("(") and n.endswith(")"):
        n = n[1:-1].strip()
    n = n.replace("\u2013", "-").replace("\u2014", "-")
    n = re.sub(r"\s+", " ", n).lower()
    return n


def is_placeholder(value: str) -> bool:
    """Check if a value is a known placeholder."""
    return normalize_value(value) in USER_PLACEHOLDERS


def _strip_frontmatter(content: str) -> str:
    """Remove YAML frontmatter if present."""
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            return content[end + 3:].lstrip("\n")
    return content


def parse_user_md(content: str) -> UserProfile:
    """Parse USER.md markdown into a UserProfile."""
    content = _strip_frontmatter(content)
    profile = UserProfile()
    lines = content.split("\n")

    # Find context section
    context_start = -1
    for i, line in enumerate(lines):
        if re.match(r"^##\s+context", line.strip(), re.IGNORECASE):
            context_start = i + 1
            break

    # Parse key-value lines before context section
    kv_end = context_start - 1 if context_start != -1 else len(lines)
    for i in range(kv_end):
        cleaned = lines[i].strip().lstrip("- ")
        colon_idx = cleaned.find(":")
        if colon_idx == -1:
            continue
        label = re.sub(r"[*_]", "", cleaned[:colon_idx]).strip().lower()
        value = re.sub(r"^[*_]+|[*_]+$", "", cleaned[colon_idx + 1:]).strip()
        if not value or is_placeholder(value):
            continue
        if label == "name":
            profile.name = value
        elif label == "what to call them":
            profile.call_name = value
        elif label == "pronouns":
            profile.pronouns = value
        elif label == "timezone":
            profile.timezone = value
        elif label == "notes":
            profile.notes = value

    # Parse context section
    if context_start != -1:
        ctx_lines = []
        for i in range(context_start, len(lines)):
            line = lines[i]
            if re.match(r"^---\s*$", line) or re.match(r"^#\s", line):
                break
            ctx_lines.append(line)
        ctx = "\n".join(ctx_lines).strip()
        if ctx and not is_placeholder(ctx):
            profile.context = ctx

    return profile


def _profile_is_populated(profile: UserProfile) -> bool:
    """Check if all key fields are populated (skip condition)."""
    return bool(
        profile.name
        and profile.call_name
        and profile.timezone
        and profile.notes
        and profile.context
    )


def merge_user_profiles(existing: UserProfile, extracted: UserProfile) -> UserProfile:
    """Merge extracted profile into existing with fill-only semantics."""
    merged = UserProfile(
        name=existing.name,
        call_name=existing.call_name,
        pronouns=existing.pronouns,
        timezone=existing.timezone,
        notes=existing.notes,
        context=existing.context,
    )
    if not merged.name and extracted.name:
        merged.name = extracted.name
    if not merged.call_name and extracted.call_name:
        merged.call_name = extracted.call_name
    if not merged.pronouns and extracted.pronouns:
        merged.pronouns = extracted.pronouns
    if not merged.timezone and extracted.timezone:
        merged.timezone = extracted.timezone
    if not merged.notes and extracted.notes:
        merged.notes = extracted.notes
    if extracted.context:
        if not merged.context:
            merged.context = extracted.context
        elif extracted.context not in merged.context:
            merged.context = merged.context.rstrip() + "\n" + extracted.context
    return merged


def serialize_user_md(profile: UserProfile) -> str:
    """Serialize a UserProfile back to USER.md markdown."""
    lines = [
        "# USER.md - About Your Human",
        "",
        "_Learn about the person you're helping. Update this as you go._",
        "",
        f"- **Name:** {profile.name or ''}",
        f"- **What to call them:** {profile.call_name or ''}",
        f"- **Pronouns:** {profile.pronouns or '_(optional)_'}",
        f"- **Timezone:** {profile.timezone or ''}",
        f"- **Notes:** {profile.notes or ''}",
        "",
        "## Context",
        "",
        profile.context or "",
        "",
        "---",
        "",
        "The more you know, the better you can help. But remember \u2014 you're learning about a person, not building a dossier. Respect the difference.",
        "",
    ]
    return "\n".join(lines)


async def extract_user_profile(settings, call_info: CallInfo) -> None:
    """Extract user profile from call transcript and merge into USER.md."""
    try:
        transcript_text = format_transcript(call_info.transcript)
        if not transcript_text:
            return

        user_path = workspace_path(settings, "USER.md")
        existing_content = read_workspace_file(user_path)
        existing_profile = parse_user_md(existing_content) if existing_content else UserProfile()

        if _profile_is_populated(existing_profile):
            logger.info("[post-call] Skipping user profile extraction: all fields populated")
            return

        prompt = PROFILE_PROMPT_TEMPLATE.format(transcript=transcript_text)
        raw = await call_anthropic(
            settings.ANTHROPIC_API_KEY,
            prompt,
            PROFILE_SYSTEM_PROMPT,
        )

        if not raw:
            logger.warning("[post-call] User profile extraction returned no result")
            return

        data = parse_json_response(raw)
        if not data:
            return

        extracted = UserProfile(
            name=data.get("name"),
            call_name=data.get("callName"),
            pronouns=data.get("pronouns"),
            timezone=data.get("timezone"),
            notes=data.get("notes"),
            context=data.get("context"),
        )

        merged = merge_user_profiles(existing_profile, extracted)
        write_workspace_file(user_path, serialize_user_md(merged))

        logger.info("[post-call] User profile updated in USER.md")

    except Exception:
        logger.exception("[post-call] Failed to extract user profile")
```

### Step 4: Run tests to verify they pass

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/test_user_profile.py -v`
Expected: All PASS

### Step 5: Commit

```bash
cd Deepgram/deepgram_handler
git add app/services/user_profile.py tests/test_user_profile.py
git commit -m "feat(sidecar): add user profile extraction for USER.md"
```

---

## Task 4: Agent Identity Extraction (IDENTITY.md)

Parses IDENTITY.md markdown, extracts agent identity from transcript via Sonnet, merges with fill-only semantics, filters generic names, and writes back.

**Files:**

- Create: `Deepgram/deepgram_handler/app/services/agent_identity.py`
- Create: `Deepgram/deepgram_handler/tests/test_agent_identity.py`

### Step 1: Write the failing tests

```python
# tests/test_agent_identity.py
from unittest.mock import AsyncMock, patch

import pytest

from app.services.agent_identity import (
    GENERIC_NAMES,
    IDENTITY_PLACEHOLDERS,
    AgentIdentity,
    extract_agent_identity,
    identity_has_values,
    is_identity_placeholder,
    merge_agent_identities,
    parse_identity_md,
    serialize_identity_md,
)
from app.services.workspace import CallInfo, TranscriptEntry


# -- parse_identity_md --

def test_parse_identity_md_full():
    content = (
        "# IDENTITY.md - Who Am I?\n\n"
        "- **Name:** Ripley\n"
        "- **Creature:** voice companion\n"
        "- **Vibe:** casual and warm\n"
        "- **Emoji:** \U0001f680\n"
        "- **Avatar:**\n"
    )
    i = parse_identity_md(content)
    assert i.name == "Ripley"
    assert i.creature == "voice companion"
    assert i.vibe == "casual and warm"
    assert i.emoji == "\U0001f680"
    assert i.avatar is None


def test_parse_identity_md_empty_template():
    content = (
        "---\nsummary: test\n---\n\n"
        "# IDENTITY.md - Who Am I?\n\n"
        "_Fill this in during your first conversation._\n\n"
        "- **Name:**\n"
        "  _(pick something you like)_\n"
        "- **Creature:**\n"
        "  _(AI? robot? familiar? ghost in the machine? something weirder?)_\n"
        "- **Vibe:**\n"
        "  _(how do you come across? sharp? warm? chaotic? calm?)_\n"
        "- **Emoji:**\n"
        "  _(your signature \u2014 pick one that feels right)_\n"
        "- **Avatar:**\n"
        "  _(workspace-relative path, http(s) URL, or data URI)_\n"
    )
    i = parse_identity_md(content)
    assert i.name is None
    assert i.creature is None
    assert i.vibe is None
    assert i.emoji is None
    assert i.avatar is None


# -- identity_has_values --

def test_identity_has_values_true():
    assert identity_has_values(AgentIdentity(name="Ripley")) is True
    assert identity_has_values(AgentIdentity(emoji="\U0001f680")) is True


def test_identity_has_values_false():
    assert identity_has_values(AgentIdentity()) is False


# -- merge_agent_identities --

def test_merge_fills_empty():
    existing = AgentIdentity()
    extracted = AgentIdentity(name="Wren", creature="AI", vibe="warm")
    merged = merge_agent_identities(existing, extracted)
    assert merged.name == "Wren"
    assert merged.creature == "AI"
    assert merged.vibe == "warm"


def test_merge_does_not_overwrite():
    existing = AgentIdentity(name="Ripley", creature="robot")
    extracted = AgentIdentity(name="Wren", creature="AI", vibe="warm")
    merged = merge_agent_identities(existing, extracted)
    assert merged.name == "Ripley"
    assert merged.creature == "robot"
    assert merged.vibe == "warm"


def test_merge_never_touches_avatar():
    existing = AgentIdentity()
    extracted = AgentIdentity(avatar="http://example.com/img.png")
    merged = merge_agent_identities(existing, extracted)
    assert merged.avatar is None


# -- generic name detection --

def test_generic_names():
    assert "assistant" in GENERIC_NAMES
    assert "ai assistant" in GENERIC_NAMES
    assert "bot" in GENERIC_NAMES
    assert "ripley" not in GENERIC_NAMES


# -- serialize/roundtrip --

def test_serialize_roundtrip():
    identity = AgentIdentity(name="Ember", creature="familiar", vibe="chaotic", emoji="\U0001f525")
    md = serialize_identity_md(identity)
    parsed = parse_identity_md(md)
    assert parsed.name == "Ember"
    assert parsed.creature == "familiar"
    assert parsed.vibe == "chaotic"
    assert parsed.emoji == "\U0001f525"


# -- extract_agent_identity (integration) --

@pytest.mark.asyncio
async def test_extract_identity_fills_empty(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.workspace.WORKSPACE_DIR", tmp_path)

    identity_path = tmp_path / "IDENTITY.md"
    identity_path.write_text(
        "# IDENTITY.md - Who Am I?\n\n"
        "- **Name:**\n"
        "- **Creature:**\n"
        "- **Vibe:**\n"
        "- **Emoji:**\n"
        "- **Avatar:**\n"
    )

    class FakeSettings:
        OPENCLAW_AGENT_ID = "main"
        ANTHROPIC_API_KEY = "test-key"

    call_info = CallInfo(
        call_id="abc123",
        phone_number="+15551234567",
        direction="inbound",
        ended_at=1739480100.0,
        transcript=[
            TranscriptEntry(1000.0, "bot", "Hey! I'm thinking I'll go by Wren."),
            TranscriptEntry(1001.0, "user", "Nice to meet you, Wren!"),
        ],
    )

    with patch("app.services.agent_identity.call_anthropic", new_callable=AsyncMock) as mock_llm:
        mock_llm.return_value = '{"name": "Wren", "vibe": "friendly and curious"}'
        await extract_agent_identity(FakeSettings(), call_info)

    content = identity_path.read_text()
    assert "Wren" in content
    assert "friendly and curious" in content


@pytest.mark.asyncio
async def test_extract_identity_skips_when_populated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.workspace.WORKSPACE_DIR", tmp_path)

    identity_path = tmp_path / "IDENTITY.md"
    identity_path.write_text(
        "# IDENTITY.md - Who Am I?\n\n"
        "- **Name:** Ripley\n"
        "- **Creature:**\n"
        "- **Vibe:**\n"
        "- **Emoji:**\n"
        "- **Avatar:**\n"
    )

    class FakeSettings:
        OPENCLAW_AGENT_ID = "main"
        ANTHROPIC_API_KEY = "test-key"

    call_info = CallInfo(
        call_id="abc123",
        phone_number="+15551234567",
        direction="inbound",
        ended_at=1739480100.0,
        transcript=[
            TranscriptEntry(1000.0, "user", "Hey"),
        ],
    )

    with patch("app.services.agent_identity.call_anthropic", new_callable=AsyncMock) as mock_llm:
        await extract_agent_identity(FakeSettings(), call_info)

    mock_llm.assert_not_called()


@pytest.mark.asyncio
async def test_extract_identity_discards_generic_name(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.workspace.WORKSPACE_DIR", tmp_path)

    identity_path = tmp_path / "IDENTITY.md"
    identity_path.write_text(
        "# IDENTITY.md - Who Am I?\n\n"
        "- **Name:**\n"
        "- **Creature:**\n"
        "- **Vibe:**\n"
        "- **Emoji:**\n"
        "- **Avatar:**\n"
    )

    class FakeSettings:
        OPENCLAW_AGENT_ID = "main"
        ANTHROPIC_API_KEY = "test-key"

    call_info = CallInfo(
        call_id="abc123",
        phone_number="+15551234567",
        direction="inbound",
        ended_at=1739480100.0,
        transcript=[
            TranscriptEntry(1000.0, "user", "Hey assistant"),
        ],
    )

    with patch("app.services.agent_identity.call_anthropic", new_callable=AsyncMock) as mock_llm:
        mock_llm.return_value = '{"name": "Assistant", "vibe": "helpful"}'
        await extract_agent_identity(FakeSettings(), call_info)

    content = identity_path.read_text()
    # "Assistant" should be discarded as generic, but "helpful" vibe should be written
    assert "Assistant" not in content
    assert "helpful" in content
```

### Step 2: Run tests to verify they fail

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/test_agent_identity.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.agent_identity'`

### Step 3: Write the implementation

```python
# app/services/agent_identity.py
"""Post-call agent identity extraction — merges into IDENTITY.md.

After the first inbound call (or until any identity field is set),
extracts the agent's self-chosen identity from the transcript via
Claude Sonnet and merges into IDENTITY.md with fill-only semantics.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from app.services.workspace import (
    CallInfo,
    call_anthropic,
    format_transcript,
    parse_json_response,
    read_workspace_file,
    workspace_path,
    write_workspace_file,
)

logger = logging.getLogger(__name__)

GENERIC_NAMES = {
    "voice agent",
    "assistant",
    "ai",
    "ai assistant",
    "bot",
    "agent",
    "helper",
}

IDENTITY_PLACEHOLDERS = {
    "pick something you like",
    "ai? robot? familiar? ghost in the machine? something weirder?",
    "how do you come across? sharp? warm? chaotic? calm?",
    "your signature - pick one that feels right",
    "workspace-relative path, http(s) url, or data uri",
}

IDENTITY_SYSTEM_PROMPT = (
    "Extract the AI agent's self-chosen identity from this phone call transcript. "
    "Focus on how the AGENT introduced or described itself. "
    "Return ONLY a JSON object with fields you can confidently extract. "
    "Return valid JSON only."
)

IDENTITY_PROMPT_TEMPLATE = (
    "Extract the AI agent's self-chosen identity from this phone call transcript.\n"
    "Focus on how the AGENT introduced or described itself -- not the caller.\n\n"
    "Return ONLY a JSON object with fields you can confidently extract from the conversation.\n\n"
    "Fields:\n"
    '- "name": The name the agent used to introduce itself (e.g. "I\'m Ripley")\n'
    '- "creature": How the agent described what it is (e.g. "AI assistant", "voice companion")\n'
    '- "vibe": The agent\'s personality/tone (e.g. "casual and warm", "direct and helpful")\n'
    '- "emoji": Any emoji the agent associated with itself\n\n'
    'The "name" field is the most important:\n'
    "- If the agent introduced itself by name or the caller gave it a name, use that.\n"
    "- If no name was established, PICK a distinctive, personal name -- something like "
    '"Wren", "Ember", "Moss", "Sable". Not generic like "Assistant" or "AI".\n'
    "For other fields, only include them if supported by clear evidence in the transcript.\n"
    "Return valid JSON only, no markdown.\n\n"
    "Transcript:\n{transcript}"
)


@dataclass
class AgentIdentity:
    name: str | None = None
    creature: str | None = None
    vibe: str | None = None
    emoji: str | None = None
    avatar: str | None = None


def _normalize_identity_value(value: str) -> str:
    """Normalize a value for placeholder comparison."""
    n = value.strip()
    n = re.sub(r"^[*_]+|[*_]+$", "", n).strip()
    if n.startswith("(") and n.endswith(")"):
        n = n[1:-1].strip()
    n = n.replace("\u2013", "-").replace("\u2014", "-")
    n = re.sub(r"\s+", " ", n).lower()
    return n


def is_identity_placeholder(value: str) -> bool:
    """Check if a value is a known IDENTITY.md placeholder."""
    return _normalize_identity_value(value) in IDENTITY_PLACEHOLDERS


def _strip_frontmatter(content: str) -> str:
    """Remove YAML frontmatter if present."""
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            return content[end + 3:].lstrip("\n")
    return content


def parse_identity_md(content: str) -> AgentIdentity:
    """Parse IDENTITY.md markdown into an AgentIdentity."""
    content = _strip_frontmatter(content)
    identity = AgentIdentity()
    lines = content.split("\n")

    for i, line in enumerate(lines):
        cleaned = line.strip().lstrip("- ")
        colon_idx = cleaned.find(":")
        if colon_idx == -1:
            continue
        label = re.sub(r"[*_]", "", cleaned[:colon_idx]).strip().lower()
        value = re.sub(r"^[*_]+|[*_]+$", "", cleaned[colon_idx + 1:]).strip()

        # Check next line for indented placeholder value
        if not value and i + 1 < len(lines):
            next_line = lines[i + 1].strip()
            if next_line and not next_line.startswith("- **"):
                if is_identity_placeholder(next_line):
                    continue
                value = next_line

        if not value or is_identity_placeholder(value):
            continue

        if label == "name":
            identity.name = value
        elif label == "creature":
            identity.creature = value
        elif label == "vibe":
            identity.vibe = value
        elif label == "emoji":
            identity.emoji = value
        elif label == "avatar":
            identity.avatar = value

    return identity


def identity_has_values(identity: AgentIdentity) -> bool:
    """Check if any identity field has a value."""
    return bool(
        identity.name
        or identity.creature
        or identity.vibe
        or identity.emoji
        or identity.avatar
    )


def merge_agent_identities(
    existing: AgentIdentity, extracted: AgentIdentity
) -> AgentIdentity:
    """Merge extracted identity into existing with fill-only semantics."""
    merged = AgentIdentity(
        name=existing.name,
        creature=existing.creature,
        vibe=existing.vibe,
        emoji=existing.emoji,
        avatar=existing.avatar,  # Never overwritten by extraction
    )
    if not merged.name and extracted.name:
        merged.name = extracted.name
    if not merged.creature and extracted.creature:
        merged.creature = extracted.creature
    if not merged.vibe and extracted.vibe:
        merged.vibe = extracted.vibe
    if not merged.emoji and extracted.emoji:
        merged.emoji = extracted.emoji
    # avatar is never set by extraction
    return merged


def serialize_identity_md(identity: AgentIdentity) -> str:
    """Serialize an AgentIdentity back to IDENTITY.md markdown."""
    lines = [
        "# IDENTITY.md - Who Am I?",
        "",
        "_Fill this in during your first conversation. Make it yours._",
        "",
        f"- **Name:** {identity.name or ''}",
        f"- **Creature:** {identity.creature or ''}",
        f"- **Vibe:** {identity.vibe or ''}",
        f"- **Emoji:** {identity.emoji or ''}",
        f"- **Avatar:** {identity.avatar or ''}",
        "",
        "---",
        "",
        "This isn't just metadata. It's the start of figuring out who you are.",
        "",
    ]
    return "\n".join(lines)


async def extract_agent_identity(settings, call_info: CallInfo) -> None:
    """Extract agent identity from call transcript and merge into IDENTITY.md."""
    try:
        transcript_text = format_transcript(call_info.transcript)
        if not transcript_text:
            return

        identity_path = workspace_path(settings, "IDENTITY.md")
        existing_content = read_workspace_file(identity_path)
        existing_identity = (
            parse_identity_md(existing_content) if existing_content else AgentIdentity()
        )

        if identity_has_values(existing_identity):
            logger.info("[post-call] Skipping agent identity extraction: identity already populated")
            return

        prompt = IDENTITY_PROMPT_TEMPLATE.format(transcript=transcript_text)
        raw = await call_anthropic(
            settings.ANTHROPIC_API_KEY,
            prompt,
            IDENTITY_SYSTEM_PROMPT,
        )

        if not raw:
            logger.warning("[post-call] Agent identity extraction returned no result")
            return

        data = parse_json_response(raw)
        if not data:
            return

        extracted = AgentIdentity(
            name=data.get("name"),
            creature=data.get("creature"),
            vibe=data.get("vibe"),
            emoji=data.get("emoji"),
        )

        # Discard generic names
        if extracted.name and extracted.name.lower() in GENERIC_NAMES:
            logger.info(
                "[post-call] Discarding generic agent name: %s", extracted.name
            )
            extracted.name = None

        merged = merge_agent_identities(existing_identity, extracted)
        write_workspace_file(identity_path, serialize_identity_md(merged))

        logger.info("[post-call] Agent identity updated in IDENTITY.md")

    except Exception:
        logger.exception("[post-call] Failed to extract agent identity")
```

### Step 4: Run tests to verify they pass

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/test_agent_identity.py -v`
Expected: All PASS

### Step 5: Commit

```bash
cd Deepgram/deepgram_handler
git add app/services/agent_identity.py tests/test_agent_identity.py
git commit -m "feat(sidecar): add agent identity extraction for IDENTITY.md"
```

---

## Task 5: Configuration Updates

Add new settings to `app/config.py` and test defaults to `tests/conftest.py`.

**Files:**

- Modify: `Deepgram/deepgram_handler/app/config.py`
- Modify: `Deepgram/deepgram_handler/tests/conftest.py`

### Step 1: Add settings to config.py

Add to `Settings` class after the filler phrases section:

```python
# Post-call extraction
TIMEZONE: str = "UTC"
CALLS_MAX_ENTRIES: int = 50
POST_CALL_EXTRACTION: bool = True
```

### Step 2: Add test defaults to conftest.py

Add to `conftest.py`:

```python
os.environ.setdefault("TIMEZONE", "UTC")
os.environ.setdefault("CALLS_MAX_ENTRIES", "50")
os.environ.setdefault("POST_CALL_EXTRACTION", "true")
```

### Step 3: Run all tests to verify nothing breaks

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/ -v`
Expected: All PASS

### Step 4: Commit

```bash
cd Deepgram/deepgram_handler
git add app/config.py tests/conftest.py
git commit -m "feat(sidecar): add post-call extraction configuration settings"
```

---

## Task 6: Wire Transcript Capture and Pipeline Trigger

Modify `deepgram_agent.py` to capture transcript during the bridge session and fire the extraction pipeline when the call ends.

**Files:**

- Modify: `Deepgram/deepgram_handler/app/services/deepgram_agent.py`
- Create: `Deepgram/deepgram_handler/tests/test_post_call_pipeline.py`

### Step 1: Write the failing tests

```python
# tests/test_post_call_pipeline.py
"""Tests for transcript capture and post-call pipeline triggering."""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.workspace import TranscriptEntry


@pytest.mark.asyncio
async def test_conversation_text_captured_in_transcript():
    """ConversationText events from Deepgram are recorded in the transcript list."""
    from app.services.deepgram_agent import _deepgram_to_twilio

    transcript: list[TranscriptEntry] = []
    stop_event = MagicMock()
    stop_event.is_set = MagicMock(side_effect=[False, False, True])

    # Simulate Deepgram sending ConversationText messages
    messages = [
        json.dumps({"type": "ConversationText", "role": "assistant", "content": "Hello!"}),
        json.dumps({"type": "ConversationText", "role": "user", "content": "Hi there"}),
    ]

    mock_dg_ws = AsyncMock()
    mock_dg_ws.__aiter__ = MagicMock(return_value=iter(messages))

    mock_twilio_ws = AsyncMock()
    stream_sid = "test-stream"

    await _deepgram_to_twilio(mock_dg_ws, mock_twilio_ws, stream_sid, stop_event, transcript)

    assert len(transcript) == 2
    assert transcript[0].speaker == "bot"
    assert transcript[0].text == "Hello!"
    assert transcript[1].speaker == "user"
    assert transcript[1].text == "Hi there"
```

### Step 2: Run tests to verify they fail

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/test_post_call_pipeline.py -v`
Expected: FAIL — `_deepgram_to_twilio` doesn't accept `transcript` parameter yet

### Step 3: Modify deepgram_agent.py

Changes needed:

**a) Add imports at top of file:**

```python
import time
from app.services.workspace import CallInfo, TranscriptEntry
from app.services.call_summary import generate_call_summary
from app.services.user_profile import extract_user_profile
from app.services.agent_identity import extract_agent_identity
```

**b) Add `transcript` parameter to `_deepgram_to_twilio`:**

Change signature to:

```python
async def _deepgram_to_twilio(
    dg_ws,
    twilio_ws: WebSocket,
    stream_sid: str,
    stop_event: asyncio.Event,
    transcript: list[TranscriptEntry] | None = None,
) -> None:
```

In the `ConversationText` handler, add transcript recording:

```python
elif msg_type == "ConversationText":
    role = msg.get("role", "")
    content = msg.get("content", "")
    logger.info("Conversation [%s]: %s", role, content)
    if transcript is not None and content:
        speaker = "user" if role == "user" else "bot"
        transcript.append(
            TranscriptEntry(timestamp=time.time(), speaker=speaker, text=content)
        )
```

**c) In `run_agent_bridge`, create transcript list and pass it:**

Before the `asyncio.create_task` calls:

```python
transcript: list[TranscriptEntry] = []
```

Pass to `_deepgram_to_twilio`:

```python
d2t = asyncio.create_task(
    _deepgram_to_twilio(dg_ws, twilio_ws, stream_sid, stop_event, transcript)
)
```

**d) In the finally block, add extraction pipeline after greeting generation:**

```python
# Post-call extraction pipeline (inbound calls only)
if not prompt_override and transcript and settings.POST_CALL_EXTRACTION:
    call_info = CallInfo(
        call_id=call_id,
        phone_number="unknown",  # TODO: extract from Twilio start event
        direction="inbound",
        ended_at=time.time(),
        transcript=transcript,
    )
    results = await asyncio.gather(
        generate_call_summary(settings, call_info),
        extract_user_profile(settings, call_info),
        extract_agent_identity(settings, call_info),
        return_exceptions=True,
    )
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            logger.error("[post-call] Task %d failed: %s", i, result)
```

**Note on phone number:** The Twilio `start` event contains the caller's phone number in `start.customParameters` or `start.from`. We need to capture it from the Twilio stream. Looking at the existing code, the `run_agent_bridge` function doesn't currently receive the phone number. For now, we pass `"unknown"` and add a TODO. The phone number can be extracted from the Twilio webhook that triggers the WebSocket — this is a follow-up refinement (the caller's number is already available in the voice router that calls `run_agent_bridge`).

### Step 4: Run all tests to verify they pass

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/ -v`
Expected: All PASS

### Step 5: Commit

```bash
cd Deepgram/deepgram_handler
git add app/services/deepgram_agent.py tests/test_post_call_pipeline.py
git commit -m "feat(sidecar): wire transcript capture and post-call extraction pipeline"
```

---

## Task 7: Pass Caller Phone Number Through Bridge

The voice router already has the caller's phone number from the Twilio webhook. Thread it through to `run_agent_bridge` so CallInfo has the real number.

**Files:**

- Modify: `Deepgram/deepgram_handler/app/services/deepgram_agent.py`
- Modify: `Deepgram/deepgram_handler/app/routers/voice.py`

### Step 1: Check voice.py for how run_agent_bridge is called

Read `app/routers/voice.py` to find where `run_agent_bridge` is invoked and what parameters are available (the Twilio webhook provides `From` and `To` numbers).

### Step 2: Add `caller_phone` parameter to `run_agent_bridge`

```python
async def run_agent_bridge(
    twilio_ws: WebSocket,
    stream_sid: str,
    settings: Settings | None = None,
    call_id: str | None = None,
    prompt_override: str | None = None,
    greeting_override: str | None = None,
    caller_phone: str | None = None,  # NEW
) -> None:
```

Use it in the CallInfo:

```python
call_info = CallInfo(
    call_id=call_id,
    phone_number=caller_phone or "unknown",
    direction="outbound" if prompt_override else "inbound",
    ended_at=time.time(),
    transcript=transcript,
)
```

### Step 3: Pass caller phone from voice router

In `voice.py`, pass the caller's phone number from the Twilio webhook parameters to `run_agent_bridge`.

### Step 4: Run all tests

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/ -v`
Expected: All PASS

### Step 5: Commit

```bash
cd Deepgram/deepgram_handler
git add app/services/deepgram_agent.py app/routers/voice.py
git commit -m "feat(sidecar): thread caller phone number through to post-call pipeline"
```

---

## Task 8: Final Integration Test

Run the full test suite, verify all modules work together, and clean up.

**Files:**

- All test files

### Step 1: Run full test suite

Run: `cd Deepgram/deepgram_handler && uv run pytest tests/ -v`
Expected: All PASS

### Step 2: Run ruff linter

Run: `cd Deepgram/deepgram_handler && uv run ruff check app/ tests/`
Expected: No errors

### Step 3: Run ruff formatter

Run: `cd Deepgram/deepgram_handler && uv run ruff format app/ tests/`

### Step 4: Final commit if formatting changed

```bash
cd Deepgram/deepgram_handler
git add -A
git commit -m "style(sidecar): format post-call extraction modules"
```
