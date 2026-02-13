import os
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import WebSocketDisconnect

from app.config import Settings
from app.services.deepgram_agent import (
    build_settings_config,
    _read_next_greeting,
    run_agent_bridge,
    NEXT_GREETING_PATH,
)


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
    assert think["provider"]["url"] == "https://deepclaw-instance.fly.dev/v1/chat/completions"
    assert think["provider"]["headers"]["Authorization"] == "Bearer gw-token"
    assert think["provider"]["headers"]["x-openclaw-session-key"] == "agent:main:abc123"
    assert "fly-force-instance-id" not in think["provider"]["headers"]
    assert "prompt" in think

    assert agent["speak"]["provider"]["type"] == "deepgram"
    assert agent["speak"]["provider"]["model"] == "aura-2-apollo-en"
    assert "greeting" in agent


def test_build_settings_config_with_fly_machine_id():
    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    with patch.dict(os.environ, {"FLY_MACHINE_ID": "machine-xyz"}):
        config = build_settings_config(settings, call_id="abc123")

    headers = config["agent"]["think"]["provider"]["headers"]
    assert headers["fly-force-instance-id"] == "machine-xyz"


def test_build_settings_config_custom():
    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        OPENCLAW_AGENT_ID="custom-agent",
        PUBLIC_URL="https://custom.example.com",
        AGENT_LISTEN_MODEL="nova-3",
        AGENT_THINK_MODEL="anthropic/claude-sonnet-4-5-20250929",
        AGENT_VOICE="aura-2-luna-en",
        AGENT_PROMPT="You are a pirate.",
        AGENT_GREETING="Ahoy!",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="call-99")
    agent = config["agent"]

    assert agent["listen"]["provider"]["model"] == "nova-3"
    assert agent["think"]["provider"]["model"] == "anthropic/claude-sonnet-4-5-20250929"
    assert agent["think"]["provider"]["url"] == "https://custom.example.com/v1/chat/completions"
    assert agent["think"]["provider"]["headers"]["x-openclaw-session-key"] == "agent:custom-agent:call-99"
    assert agent["think"]["prompt"] == "You are a pirate."
    assert agent["speak"]["provider"]["model"] == "aura-2-luna-en"
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

    assert agent["think"]["prompt"] == "Call the pizza place and order a large pepperoni."
    assert agent["greeting"] == "Hello!"
    # Session key uses the provided call_id
    assert "outbound-abc123" in agent["think"]["endpoint"]["headers"]["x-openclaw-session-key"]


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
    greeting_file = tmp_path / "NEXT_GREETING.txt"
    greeting_file.write_text("So you're back. What do you need?")
    monkeypatch.setattr("app.services.deepgram_agent.NEXT_GREETING_PATH", greeting_file)
    # Also ensure USER.md doesn't exist so we hit the new-caller branch
    monkeypatch.setattr("app.services.deepgram_agent.USER_MD_PATH", tmp_path / "nope.md")

    settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        _env_file=None,
    )
    config = build_settings_config(settings, call_id="abc123")
    assert config["agent"]["greeting"] == "So you're back. What do you need?"


def test_build_settings_falls_back_when_no_greeting_file(tmp_path, monkeypatch):
    """When no NEXT_GREETING.txt, fall back to default greeting."""
    monkeypatch.setattr("app.services.deepgram_agent.NEXT_GREETING_PATH", tmp_path / "nope.txt")
    monkeypatch.setattr("app.services.deepgram_agent.USER_MD_PATH", tmp_path / "nope.md")

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
        json={"choices": [{"message": {"content": "Back again? Let's make it count."}}]},
        request=httpx.Request("POST", "http://localhost:18789/v1/chat/completions"),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)
    monkeypatch.setattr("app.services.deepgram_agent.httpx.AsyncClient", lambda: mock_client)

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
    monkeypatch.setattr("app.services.deepgram_agent.httpx.AsyncClient", lambda: mock_client)

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
        yield  # noqa: make it a generator
    mock_dg_ws.__aiter__ = lambda self: empty_iter()

    mock_connect = AsyncMock(return_value=mock_dg_ws)
    monkeypatch.setattr("app.services.deepgram_agent.connect", mock_connect)

    mock_generate = AsyncMock()
    monkeypatch.setattr("app.services.deepgram_agent._generate_next_greeting", mock_generate)

    mock_twilio_ws = AsyncMock()
    mock_twilio_ws.receive_text = AsyncMock(side_effect=WebSocketDisconnect())

    await run_agent_bridge(mock_twilio_ws, "stream-123", settings=settings, call_id="test-call")

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
    monkeypatch.setattr("app.services.deepgram_agent._generate_next_greeting", mock_generate)

    mock_twilio_ws = AsyncMock()
    mock_twilio_ws.receive_text = AsyncMock(side_effect=WebSocketDisconnect())

    await run_agent_bridge(
        mock_twilio_ws, "stream-456", settings=settings,
        call_id="outbound-abc", prompt_override="Call the pizza place.",
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
    monkeypatch.setattr("app.services.deepgram_agent._generate_next_greeting", mock_generate)

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

    monkeypatch.setattr("app.services.deepgram_agent.session_registry.register", track_register)
    monkeypatch.setattr("app.services.deepgram_agent.session_registry.unregister", track_unregister)

    mock_twilio_ws = AsyncMock()
    mock_twilio_ws.receive_text = AsyncMock(side_effect=WebSocketDisconnect())

    await run_agent_bridge(mock_twilio_ws, "stream-reg", settings=settings, call_id="reg-call")

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
    from app.services import session_registry

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
    monkeypatch.setattr("app.services.deepgram_agent._generate_next_greeting", mock_generate)

    unregistered_keys: list[str] = []
    monkeypatch.setattr(
        "app.services.deepgram_agent.session_registry.unregister",
        lambda key: unregistered_keys.append(key),
    )

    mock_twilio_ws = AsyncMock()
    mock_twilio_ws.receive_text = AsyncMock(side_effect=WebSocketDisconnect())

    await run_agent_bridge(mock_twilio_ws, "stream-err", settings=settings, call_id="err-call")

    assert len(unregistered_keys) == 1
    assert "err-call" in unregistered_keys[0]
