from pathlib import Path
from unittest.mock import patch

from app.services.sms_context import (
    NEW_USER_SMS_PROMPT,
    KNOWN_USER_SMS_PROMPT,
    build_sms_messages,
)


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
