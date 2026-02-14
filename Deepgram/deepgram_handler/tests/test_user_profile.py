# tests/test_user_profile.py
from unittest.mock import AsyncMock, patch

import pytest

from app.services.user_profile import (
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
        OPENCLAW_GATEWAY_TOKEN = "gw-token"

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

    with patch(
        "app.services.user_profile.call_anthropic", new_callable=AsyncMock
    ) as mock_llm:
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
        OPENCLAW_GATEWAY_TOKEN = "gw-token"

    call_info = CallInfo(
        call_id="abc123",
        phone_number="+15551234567",
        direction="inbound",
        ended_at=1739480100.0,
        transcript=[
            TranscriptEntry(1000.0, "user", "Hey"),
        ],
    )

    with patch(
        "app.services.user_profile.call_anthropic", new_callable=AsyncMock
    ) as mock_llm:
        await extract_user_profile(FakeSettings(), call_info)

    # LLM should not have been called -- all key fields populated
    mock_llm.assert_not_called()
