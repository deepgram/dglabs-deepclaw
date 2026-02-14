# tests/test_agent_identity.py
from unittest.mock import AsyncMock, patch

import pytest

from app.services.agent_identity import (
    GENERIC_NAMES,
    AgentIdentity,
    extract_agent_identity,
    identity_has_values,
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
    identity = AgentIdentity(
        name="Ember", creature="familiar", vibe="chaotic", emoji="\U0001f525"
    )
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
        OPENCLAW_GATEWAY_TOKEN = "gw-token"

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

    with patch(
        "app.services.agent_identity.call_anthropic", new_callable=AsyncMock
    ) as mock_llm:
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
        "app.services.agent_identity.call_anthropic", new_callable=AsyncMock
    ) as mock_llm:
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
        OPENCLAW_GATEWAY_TOKEN = "gw-token"

    call_info = CallInfo(
        call_id="abc123",
        phone_number="+15551234567",
        direction="inbound",
        ended_at=1739480100.0,
        transcript=[
            TranscriptEntry(1000.0, "user", "Hey assistant"),
        ],
    )

    with patch(
        "app.services.agent_identity.call_anthropic", new_callable=AsyncMock
    ) as mock_llm:
        mock_llm.return_value = '{"name": "Assistant", "vibe": "helpful"}'
        await extract_agent_identity(FakeSettings(), call_info)

    content = identity_path.read_text()
    # "Assistant" should be discarded as generic, but "helpful" vibe should be written
    assert "Assistant" not in content
    assert "helpful" in content
