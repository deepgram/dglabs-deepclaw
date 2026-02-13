from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.sms_context import (
    NEW_USER_SMS_PROMPT,
    KNOWN_USER_SMS_PROMPT,
    build_sms_messages,
    truncate_reply,
)


# --- build_sms_messages ---


def test_new_user_gets_new_user_prompt():
    """When USER.md does not exist, system prompt should be the new-user prompt."""
    with patch("app.services.sms_context.USER_MD_PATH", Path("/nonexistent/USER.md")):
        messages = build_sms_messages("hey there")

    assert len(messages) == 2
    assert messages[0]["role"] == "system"
    assert messages[0]["content"] == NEW_USER_SMS_PROMPT
    assert messages[1] == {"role": "user", "content": "hey there"}


def test_known_user_gets_context_in_prompt(tmp_path):
    """When USER.md exists, system prompt should include its contents."""
    user_md = tmp_path / "USER.md"
    user_md.write_text("Name: Alice\nLikes: cats")

    with patch("app.services.sms_context.USER_MD_PATH", user_md):
        messages = build_sms_messages("hello")

    assert len(messages) == 2
    assert messages[0]["role"] == "system"
    assert KNOWN_USER_SMS_PROMPT in messages[0]["content"]
    assert "Name: Alice" in messages[0]["content"]
    assert messages[1] == {"role": "user", "content": "hello"}


def test_empty_user_md_treated_as_new_user(tmp_path):
    """An empty USER.md should be treated like a new user."""
    user_md = tmp_path / "USER.md"
    user_md.write_text("   ")

    with patch("app.services.sms_context.USER_MD_PATH", user_md):
        messages = build_sms_messages("hi")

    assert messages[0]["content"] == NEW_USER_SMS_PROMPT


def test_multimodal_content_passed_through():
    """Multimodal content (list) should be passed through as-is."""
    content = [
        {"type": "text", "text": "look at this"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
    ]

    with patch("app.services.sms_context.USER_MD_PATH", Path("/nonexistent/USER.md")):
        messages = build_sms_messages(content)

    assert messages[1]["content"] is content


# --- truncate_reply ---


def test_short_reply_unchanged():
    assert truncate_reply("Hello!") == "Hello!"


def test_exactly_at_limit():
    text = "A" * 1600
    assert truncate_reply(text) == text


def test_truncate_at_newline():
    """Should prefer breaking at the last newline within the limit."""
    text = "First paragraph.\n" + "B" * 1600
    result = truncate_reply(text)
    assert result == "First paragraph."


def test_truncate_at_sentence_end():
    """When no newline, should break at last sentence-ending punctuation."""
    text = "First sentence. Second sentence! " + "B" * 1600
    result = truncate_reply(text)
    assert result == "First sentence. Second sentence!"


def test_truncate_hard_cut():
    """When no newline or punctuation, should hard-cut with ellipsis."""
    text = "A" * 2000
    result = truncate_reply(text)
    assert len(result) == 1600
    assert result.endswith("...")


def test_truncate_custom_limit():
    text = "Hello world. Goodbye world."
    result = truncate_reply(text, limit=15)
    assert result == "Hello world."


# --- ask_openclaw ---


@pytest.mark.asyncio
async def test_ask_openclaw_returns_reply():
    from app.services.sms_context import ask_openclaw

    mock_resp = MagicMock()
    mock_resp.json.return_value = {"choices": [{"message": {"content": "Hi there!"}}]}
    mock_resp.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post.return_value = mock_resp
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    settings = MagicMock()
    settings.OPENCLAW_GATEWAY_TOKEN = "tok"
    settings.AGENT_THINK_MODEL = "model"

    with (
        patch("app.services.sms_context.httpx.AsyncClient", return_value=mock_client),
        patch("app.services.sms_context.USER_MD_PATH", Path("/nonexistent/USER.md")),
    ):
        result = await ask_openclaw(settings, "session-key", "hello")

    assert result == "Hi there!"

    call_args = mock_client.post.call_args
    headers = call_args[1]["headers"]
    assert headers["x-openclaw-session-key"] == "session-key"
    body = call_args[1]["json"]
    assert body["messages"][0]["role"] == "system"
    assert body["messages"][1]["role"] == "user"
    assert body["messages"][1]["content"] == "hello"
