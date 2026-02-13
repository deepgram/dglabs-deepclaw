import os
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import WebSocketDisconnect

from app.config import Settings
from app.services.deepgram_agent import (
    _read_next_greeting,
    build_settings_config,
    run_agent_bridge,
)


def _mock_workspace_empty(monkeypatch, tmp_path):
    """Point all workspace paths at nonexistent files (first-caller scenario)."""
    monkeypatch.setattr("app.services.deepgram_agent.USER_MD_PATH", tmp_path / "nope.md")
    monkeypatch.setattr("app.services.deepgram_agent.IDENTITY_MD_PATH", tmp_path / "nope-id.md")
    monkeypatch.setattr("app.services.deepgram_agent.CALLS_MD_PATH", tmp_path / "nope-calls.md")
    monkeypatch.setattr("app.services.deepgram_agent.NEXT_GREETING_PATH", tmp_path / "nope.txt")


FILLED_USER_MD = """\
# USER.md - About Your Human

- **Name:** Bill Getman
- **What to call them:** Bill
- **Pronouns:** he/him
- **Timezone:** America/New_York
- **Notes:** Works on DeepClaw

## Context

Building a voice AI platform.
"""

BLANK_USER_MD = """\
# USER.md - About Your Human

- **Name:**
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**
- **Notes:**

## Context

_(placeholder)_
"""

FILLED_IDENTITY_MD = """\
# IDENTITY.md - Who Am I?

- **Name:** Cleo
- **Creature:** AI familiar
"""

BLANK_IDENTITY_MD = """\
# IDENTITY.md - Who Am I?

- **Name:**
  _(pick something you like)_
"""

SAMPLE_CALLS_MD = """\
### 2026-02-12 09:15 — Morning standup
Discussed deployment blockers.

### 2026-02-13 16:45 — Voice prompt testing
Testing the new prompt builder.
"""


def test_build_settings_config_defaults():
    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="abc123")

    assert config["type"] == "Settings"

    # Audio: mulaw 8kHz in and out
    assert config["audio"]["input"]["encoding"] == "mulaw"
    assert config["audio"]["input"]["sample_rate"] == 8000
    assert config["audio"]["output"]["encoding"] == "mulaw"
    assert config["audio"]["output"]["sample_rate"] == 8000
    assert config["audio"]["output"]["container"] == "none"

    # Agent config
    agent = config["agent"]
    assert agent["listen"]["provider"]["type"] == "deepgram"
    assert agent["listen"]["provider"]["model"] == "flux-general-en"

    think = agent["think"]
    assert think["provider"]["type"] == "open_ai"
    assert think["provider"]["model"] == "anthropic/claude-haiku-4-5"
    assert (
        think["endpoint"]["url"]
        == "https://deepclaw-instance.fly.dev/v1/chat/completions"
    )
    assert think["endpoint"]["headers"]["Authorization"] == "Bearer gw-token"
    assert think["endpoint"]["headers"]["x-openclaw-session-key"] == "agent:main:abc123"
    assert "fly-force-instance-id" not in think["endpoint"]["headers"]
    assert "prompt" in think

    assert agent["speak"]["provider"]["type"] == "deepgram"
    assert agent["speak"]["provider"]["model"] == "aura-2-thalia-en"
    assert "greeting" in agent


def test_build_settings_config_with_fly_machine_id():
    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    with patch.dict(os.environ, {"FLY_MACHINE_ID": "machine-xyz"}):
        config = build_settings_config(settings, call_id="abc123")

    headers = config["agent"]["think"]["endpoint"]["headers"]
    assert headers["fly-force-instance-id"] == "machine-xyz"


def test_build_settings_config_custom(tmp_path, monkeypatch):
    """Custom models, URLs, and agent ID are wired through correctly."""
    _mock_workspace_empty(monkeypatch, tmp_path)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        OPENCLAW_AGENT_ID="custom-agent",
        PUBLIC_URL="https://custom.example.com",
        AGENT_LISTEN_MODEL="nova-3",
        AGENT_THINK_MODEL="anthropic/claude-sonnet-4-5-20250929",
        AGENT_VOICE="aura-2-luna-en",
        AGENT_GREETING="Ahoy!",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="call-99")
    agent = config["agent"]

    assert agent["listen"]["provider"]["model"] == "nova-3"
    assert agent["think"]["provider"]["model"] == "anthropic/claude-sonnet-4-5-20250929"
    assert (
        agent["think"]["endpoint"]["url"]
        == "https://custom.example.com/v1/chat/completions"
    )
    assert (
        agent["think"]["endpoint"]["headers"]["x-openclaw-session-key"]
        == "agent:custom-agent:call-99"
    )
    # Inbound calls use _build_voice_prompt() — prompt contains voice constraints
    assert "Voice constraints" in agent["think"]["prompt"] or "phone call" in agent["think"]["prompt"]
    assert agent["speak"]["provider"]["model"] == "aura-2-luna-en"
    # No USER.md → first caller → uses settings.AGENT_GREETING as fallback
    assert agent["greeting"] == "Ahoy!"


def test_build_settings_config_with_prompt_override():
    """Prompt override is used for outbound calls where the callee is not the user."""
    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        AGENT_PROMPT="Default prompt.",
        AGENT_GREETING="Default greeting.",
        _env_file=None,
    )
    config = build_settings_config(
        settings,
        call_id="outbound-abc123",
        prompt_override="Call the pizza place and order a large pepperoni.",
        greeting_override="Hello!",
    )
    agent = config["agent"]

    assert (
        agent["think"]["prompt"] == "Call the pizza place and order a large pepperoni."
    )
    assert agent["greeting"] == "Hello!"
    # Session key uses the provided call_id
    assert (
        "outbound-abc123"
        in agent["think"]["endpoint"]["headers"]["x-openclaw-session-key"]
    )


def test_build_settings_config_prompt_override_default_greeting():
    """Prompt override without greeting override defaults to 'Hello!'."""
    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    config = build_settings_config(
        settings,
        call_id="outbound-xyz789",
        prompt_override="Check on delivery status.",
    )

    assert config["agent"]["think"]["prompt"] == "Check on delivery status."
    assert config["agent"]["greeting"] == "Hello!"


def test_read_next_greeting_returns_content(tmp_path, monkeypatch):
    greeting_file = tmp_path / "NEXT_GREETING.txt"
    greeting_file.write_text("Hey, welcome back you legend.")
    monkeypatch.setattr("app.services.deepgram_agent.NEXT_GREETING_PATH", greeting_file)
    assert _read_next_greeting() == "Hey, welcome back you legend."


def test_read_next_greeting_returns_none_when_missing(tmp_path, monkeypatch):
    greeting_file = tmp_path / "NEXT_GREETING.txt"
    monkeypatch.setattr("app.services.deepgram_agent.NEXT_GREETING_PATH", greeting_file)
    assert _read_next_greeting() is None


def test_read_next_greeting_returns_none_when_empty(tmp_path, monkeypatch):
    greeting_file = tmp_path / "NEXT_GREETING.txt"
    greeting_file.write_text("   ")
    monkeypatch.setattr("app.services.deepgram_agent.NEXT_GREETING_PATH", greeting_file)
    assert _read_next_greeting() is None


def test_build_settings_uses_next_greeting_file(tmp_path, monkeypatch):
    """When NEXT_GREETING.txt exists, use it as the greeting."""
    _mock_workspace_empty(monkeypatch, tmp_path)
    greeting_file = tmp_path / "NEXT_GREETING.txt"
    greeting_file.write_text("So you're back. What do you need?")
    monkeypatch.setattr("app.services.deepgram_agent.NEXT_GREETING_PATH", greeting_file)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="abc123")
    assert config["agent"]["greeting"] == "So you're back. What do you need?"


def test_build_settings_falls_back_when_no_greeting_file(tmp_path, monkeypatch):
    """When no NEXT_GREETING.txt, fall back to default greeting."""
    _mock_workspace_empty(monkeypatch, tmp_path)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="abc123")
    # Falls back to the settings default
    assert config["agent"]["greeting"] == settings.AGENT_GREETING


def test_build_settings_greeting_file_ignored_for_outbound(tmp_path, monkeypatch):
    """Outbound calls always use greeting_override, not the file."""
    greeting_file = tmp_path / "NEXT_GREETING.txt"
    greeting_file.write_text("This should NOT be used.")
    monkeypatch.setattr("app.services.deepgram_agent.NEXT_GREETING_PATH", greeting_file)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    config = build_settings_config(
        settings,
        call_id="outbound-xyz",
        prompt_override="Call the dentist.",
        greeting_override="Hi there!",
    )
    assert config["agent"]["greeting"] == "Hi there!"


@pytest.mark.asyncio
async def test_generate_next_greeting_writes_file(tmp_path, monkeypatch):
    from app.services.deepgram_agent import _generate_next_greeting

    greeting_file = tmp_path / "NEXT_GREETING.txt"
    monkeypatch.setattr("app.services.deepgram_agent.NEXT_GREETING_PATH", greeting_file)

    mock_response = httpx.Response(
        200,
        json={
            "choices": [{"message": {"content": "Back again? Let's make it count."}}]
        },
        request=httpx.Request("POST", "http://localhost:18789/v1/chat/completions"),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)
    monkeypatch.setattr(
        "app.services.deepgram_agent.httpx.AsyncClient", lambda: mock_client
    )

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    await _generate_next_greeting(settings, session_key="agent:main:abc123")

    assert greeting_file.read_text() == "Back again? Let's make it count."


@pytest.mark.asyncio
async def test_generate_next_greeting_handles_failure(tmp_path, monkeypatch):
    """If OpenClaw call fails, no file is written and no exception propagates."""
    from app.services.deepgram_agent import _generate_next_greeting

    greeting_file = tmp_path / "NEXT_GREETING.txt"
    monkeypatch.setattr("app.services.deepgram_agent.NEXT_GREETING_PATH", greeting_file)

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(side_effect=httpx.ConnectError("connection refused"))
    monkeypatch.setattr(
        "app.services.deepgram_agent.httpx.AsyncClient", lambda: mock_client
    )

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    # Should not raise
    await _generate_next_greeting(settings, session_key="agent:main:abc123")

    assert not greeting_file.exists()


@pytest.mark.asyncio
async def test_run_agent_bridge_calls_generate_next_greeting(monkeypatch):
    """After bridge finishes, _generate_next_greeting is called for inbound calls."""
    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )

    # Mock the websocket connection to Deepgram so it immediately closes
    mock_dg_ws = AsyncMock()
    mock_dg_ws.close = AsyncMock()
    mock_dg_ws.send = AsyncMock()

    # Make __aiter__ return an empty async iterator
    async def empty_iter():
        return
        yield  # noqa: F841

    mock_dg_ws.__aiter__ = lambda self: empty_iter()

    mock_connect = AsyncMock(return_value=mock_dg_ws)
    monkeypatch.setattr("app.services.deepgram_agent.connect", mock_connect)

    mock_generate = AsyncMock()
    monkeypatch.setattr(
        "app.services.deepgram_agent._generate_next_greeting", mock_generate
    )

    mock_twilio_ws = AsyncMock()
    mock_twilio_ws.receive_text = AsyncMock(side_effect=WebSocketDisconnect())

    await run_agent_bridge(
        mock_twilio_ws, "stream-123", settings=settings, call_id="test-call"
    )

    mock_generate.assert_called_once()
    call_args = mock_generate.call_args
    assert call_args[0][0] is settings
    assert "test-call" in call_args[1]["session_key"]


@pytest.mark.asyncio
async def test_run_agent_bridge_skips_greeting_gen_for_outbound(monkeypatch):
    """Outbound calls (prompt_override set) should NOT generate a next greeting."""
    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )

    mock_dg_ws = AsyncMock()
    mock_dg_ws.close = AsyncMock()
    mock_dg_ws.send = AsyncMock()

    async def empty_iter():
        return
        yield

    mock_dg_ws.__aiter__ = lambda self: empty_iter()

    mock_connect = AsyncMock(return_value=mock_dg_ws)
    monkeypatch.setattr("app.services.deepgram_agent.connect", mock_connect)

    mock_generate = AsyncMock()
    monkeypatch.setattr(
        "app.services.deepgram_agent._generate_next_greeting", mock_generate
    )

    mock_twilio_ws = AsyncMock()
    mock_twilio_ws.receive_text = AsyncMock(side_effect=WebSocketDisconnect())

    await run_agent_bridge(
        mock_twilio_ws,
        "stream-456",
        settings=settings,
        call_id="outbound-abc",
        prompt_override="Call the pizza place.",
    )

    mock_generate.assert_not_called()


@pytest.mark.asyncio
async def test_run_agent_bridge_registers_session(monkeypatch):
    """Bridge registers the session key in the session registry on connect."""
    from app.services import session_registry

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )

    mock_dg_ws = AsyncMock()
    mock_dg_ws.close = AsyncMock()
    mock_dg_ws.send = AsyncMock()

    async def empty_iter():
        return
        yield

    mock_dg_ws.__aiter__ = lambda self: empty_iter()

    mock_connect = AsyncMock(return_value=mock_dg_ws)
    monkeypatch.setattr("app.services.deepgram_agent.connect", mock_connect)

    mock_generate = AsyncMock()
    monkeypatch.setattr(
        "app.services.deepgram_agent._generate_next_greeting", mock_generate
    )

    # Track register/unregister calls
    registered_keys: list[str] = []
    unregistered_keys: list[str] = []
    original_register = session_registry.register
    original_unregister = session_registry.unregister

    def track_register(key, ws):
        registered_keys.append(key)
        original_register(key, ws)

    def track_unregister(key):
        unregistered_keys.append(key)
        original_unregister(key)

    monkeypatch.setattr(
        "app.services.deepgram_agent.session_registry.register", track_register
    )
    monkeypatch.setattr(
        "app.services.deepgram_agent.session_registry.unregister", track_unregister
    )

    mock_twilio_ws = AsyncMock()
    mock_twilio_ws.receive_text = AsyncMock(side_effect=WebSocketDisconnect())

    await run_agent_bridge(
        mock_twilio_ws, "stream-reg", settings=settings, call_id="reg-call"
    )

    # Should have registered with the session key
    assert len(registered_keys) == 1
    assert "reg-call" in registered_keys[0]
    assert registered_keys[0] == "agent:main:reg-call"

    # Should have unregistered on cleanup
    assert len(unregistered_keys) == 1
    assert unregistered_keys[0] == registered_keys[0]


@pytest.mark.asyncio
async def test_run_agent_bridge_unregisters_on_error(monkeypatch):
    """Session is unregistered even if the bridge errors out."""
    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )

    mock_dg_ws = AsyncMock()
    mock_dg_ws.close = AsyncMock()
    mock_dg_ws.send = AsyncMock()

    # Simulate an error during iteration
    async def error_iter():
        raise RuntimeError("boom")
        yield  # noqa

    mock_dg_ws.__aiter__ = lambda self: error_iter()

    mock_connect = AsyncMock(return_value=mock_dg_ws)
    monkeypatch.setattr("app.services.deepgram_agent.connect", mock_connect)

    mock_generate = AsyncMock()
    monkeypatch.setattr(
        "app.services.deepgram_agent._generate_next_greeting", mock_generate
    )

    unregistered_keys: list[str] = []
    monkeypatch.setattr(
        "app.services.deepgram_agent.session_registry.unregister",
        lambda key: unregistered_keys.append(key),
    )

    mock_twilio_ws = AsyncMock()
    mock_twilio_ws.receive_text = AsyncMock(side_effect=WebSocketDisconnect())

    await run_agent_bridge(
        mock_twilio_ws, "stream-err", settings=settings, call_id="err-call"
    )

    assert len(unregistered_keys) == 1
    assert "err-call" in unregistered_keys[0]


# ---------------------------------------------------------------------------
# Enhanced prompt builder tests
# ---------------------------------------------------------------------------


def test_returning_caller_prompt(tmp_path, monkeypatch):
    """Known user with filled USER.md gets caller context in prompt."""
    _mock_workspace_empty(monkeypatch, tmp_path)

    # Write filled USER.md
    user_file = tmp_path / "user.md"
    user_file.write_text(FILLED_USER_MD)
    monkeypatch.setattr("app.services.deepgram_agent.USER_MD_PATH", user_file)

    # Write filled IDENTITY.md
    identity_file = tmp_path / "identity.md"
    identity_file.write_text(FILLED_IDENTITY_MD)
    monkeypatch.setattr("app.services.deepgram_agent.IDENTITY_MD_PATH", identity_file)

    # Write CALLS.md
    calls_file = tmp_path / "calls.md"
    calls_file.write_text(SAMPLE_CALLS_MD)
    monkeypatch.setattr("app.services.deepgram_agent.CALLS_MD_PATH", calls_file)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="ret-123")
    prompt = config["agent"]["think"]["prompt"]

    # Should contain caller context
    assert "Bill" in prompt
    assert "Caller context" in prompt
    assert "Works on DeepClaw" in prompt
    assert "voice AI platform" in prompt

    # Should contain recent calls
    assert "Recent calls" in prompt
    assert "Morning standup" in prompt

    # Should contain returning caller nudge
    assert "returning caller" in prompt.lower()

    # Should NOT contain first-caller bootstrap
    assert "First-caller bootstrap" not in prompt

    # Greeting should use name
    assert config["agent"]["greeting"] == "Hey Bill!"


def test_first_caller_prompt(tmp_path, monkeypatch):
    """No USER.md + blank IDENTITY.md triggers first-caller bootstrap."""
    _mock_workspace_empty(monkeypatch, tmp_path)

    # Write blank identity
    identity_file = tmp_path / "identity.md"
    identity_file.write_text(BLANK_IDENTITY_MD)
    monkeypatch.setattr("app.services.deepgram_agent.IDENTITY_MD_PATH", identity_file)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="first-123")
    prompt = config["agent"]["think"]["prompt"]

    # Should contain bootstrap instructions
    assert "First-caller bootstrap" in prompt
    assert "haven't picked one yet" in prompt
    assert "call me [name]" in prompt.lower()

    # Should contain first-caller nudge
    assert "first-time caller" in prompt.lower()

    # Should NOT contain caller context
    assert "Caller context" not in prompt


def test_returning_caller_no_calls_md(tmp_path, monkeypatch):
    """Known user without CALLS.md still gets caller context, no recent calls section."""
    _mock_workspace_empty(monkeypatch, tmp_path)

    user_file = tmp_path / "user.md"
    user_file.write_text(FILLED_USER_MD)
    monkeypatch.setattr("app.services.deepgram_agent.USER_MD_PATH", user_file)

    identity_file = tmp_path / "identity.md"
    identity_file.write_text(FILLED_IDENTITY_MD)
    monkeypatch.setattr("app.services.deepgram_agent.IDENTITY_MD_PATH", identity_file)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="ret-no-calls")
    prompt = config["agent"]["think"]["prompt"]

    assert "Caller context" in prompt
    assert "Bill" in prompt
    assert "Recent calls" not in prompt


def test_action_nudges_disabled(tmp_path, monkeypatch):
    """When ENABLE_ACTION_NUDGES=False, no nudge lines in prompt."""
    _mock_workspace_empty(monkeypatch, tmp_path)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        ENABLE_ACTION_NUDGES=False,
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="no-nudge")
    prompt = config["agent"]["think"]["prompt"]

    assert "Nudge:" not in prompt


def test_action_nudges_enabled_first_caller(tmp_path, monkeypatch):
    """First caller with nudges enabled gets the first-caller nudge."""
    _mock_workspace_empty(monkeypatch, tmp_path)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        ENABLE_ACTION_NUDGES=True,
        FIRST_CALLER_NUDGE_WINDOW_SEC=20,
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="nudge-first")
    prompt = config["agent"]["think"]["prompt"]

    assert "first-time caller" in prompt.lower()
    assert "20 seconds" in prompt


def test_returning_caller_nudge_window(tmp_path, monkeypatch):
    """Returning caller nudge uses the configured window."""
    _mock_workspace_empty(monkeypatch, tmp_path)

    user_file = tmp_path / "user.md"
    user_file.write_text(FILLED_USER_MD)
    monkeypatch.setattr("app.services.deepgram_agent.USER_MD_PATH", user_file)

    identity_file = tmp_path / "identity.md"
    identity_file.write_text(FILLED_IDENTITY_MD)
    monkeypatch.setattr("app.services.deepgram_agent.IDENTITY_MD_PATH", identity_file)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        RETURNING_CALLER_NUDGE_WINDOW_SEC=60,
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="nudge-ret")
    prompt = config["agent"]["think"]["prompt"]

    assert "returning caller" in prompt.lower()
    assert "60 seconds" in prompt


def test_prompt_contains_utc_time(tmp_path, monkeypatch):
    """Prompt always includes current UTC time."""
    _mock_workspace_empty(monkeypatch, tmp_path)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="time-test")
    prompt = config["agent"]["think"]["prompt"]

    assert "UTC" in prompt


def test_prompt_contains_timezone_when_known(tmp_path, monkeypatch):
    """When USER.md has a timezone, it appears in the prompt."""
    _mock_workspace_empty(monkeypatch, tmp_path)

    user_file = tmp_path / "user.md"
    user_file.write_text(FILLED_USER_MD)
    monkeypatch.setattr("app.services.deepgram_agent.USER_MD_PATH", user_file)

    identity_file = tmp_path / "identity.md"
    identity_file.write_text(FILLED_IDENTITY_MD)
    monkeypatch.setattr("app.services.deepgram_agent.IDENTITY_MD_PATH", identity_file)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="tz-test")
    prompt = config["agent"]["think"]["prompt"]

    assert "America/New_York" in prompt


def test_blank_user_md_treated_as_first_caller(tmp_path, monkeypatch):
    """A USER.md that exists but has only placeholders is treated as first caller."""
    _mock_workspace_empty(monkeypatch, tmp_path)

    user_file = tmp_path / "user.md"
    user_file.write_text(BLANK_USER_MD)
    monkeypatch.setattr("app.services.deepgram_agent.USER_MD_PATH", user_file)

    # Blank identity too
    identity_file = tmp_path / "identity.md"
    identity_file.write_text(BLANK_IDENTITY_MD)
    monkeypatch.setattr("app.services.deepgram_agent.IDENTITY_MD_PATH", identity_file)

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="blank-user")
    prompt = config["agent"]["think"]["prompt"]

    # Should be first-caller (blank USER.md + blank IDENTITY.md)
    assert "First-caller bootstrap" in prompt
    assert "Caller context" not in prompt


def test_build_settings_config_includes_end_call_function():
    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="test-token",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="test123")
    functions = config["agent"]["think"].get("functions", [])
    names = [f["name"] for f in functions]
    assert "end_call" in names

    end_call = next(f for f in functions if f["name"] == "end_call")
    assert "farewell" in end_call["parameters"]["properties"]
    assert "farewell" in end_call["parameters"]["required"]
