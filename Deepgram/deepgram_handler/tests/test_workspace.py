# tests/test_workspace.py
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.services.workspace import (
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
    assert (
        result == "Agent: Hello!\nCaller: Hi, how are you?\nAgent: I'm great, thanks!"
    )


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

    assert (
        workspace_path(FakeSettings(), "USER.md")
        == tmp_path / "voice-agent" / "USER.md"
    )


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
        json={
            "choices": [{"message": {"content": "Summary here.", "role": "assistant"}}]
        },
        request=httpx.Request("POST", "http://localhost:18789/v1/chat/completions"),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.workspace.httpx.AsyncClient", return_value=mock_client):
        result = await call_anthropic("gw-token", "Extract info", "You are helpful")

    assert result == "Summary here."
    call_kwargs = mock_client.post.call_args[1]
    assert call_kwargs["headers"]["Authorization"] == "Bearer gw-token"
    body = call_kwargs["json"]
    assert body["model"] == "litellm/claude-sonnet-4-5-20250929"
    assert body["messages"][0]["content"] == "You are helpful"
    assert body["messages"][1]["content"] == "Extract info"


@pytest.mark.asyncio
async def test_call_anthropic_empty_key():
    result = await call_anthropic("", "prompt", "system")
    assert result is None


@pytest.mark.asyncio
async def test_call_anthropic_http_error():
    mock_response = httpx.Response(
        500,
        json={"error": "internal"},
        request=httpx.Request("POST", "http://localhost:18789/v1/chat/completions"),
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
