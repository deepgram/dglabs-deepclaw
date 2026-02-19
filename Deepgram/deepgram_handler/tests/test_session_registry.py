from unittest.mock import MagicMock

from app.services.session_registry import (
    get_session,
    get_ws,
    is_muted,
    register,
    set_muted,
    set_timers,
    should_unmute,
    unregister,
)


def test_register_and_get_ws():
    mock_ws = MagicMock()
    register("agent:main:abc123", mock_ws)
    assert get_ws("agent:main:abc123") is mock_ws
    # Cleanup
    unregister("agent:main:abc123")


def test_get_ws_returns_none_for_unknown():
    assert get_ws("agent:main:nonexistent") is None


def test_unregister_removes_session():
    mock_ws = MagicMock()
    register("agent:main:xyz789", mock_ws)
    unregister("agent:main:xyz789")
    assert get_ws("agent:main:xyz789") is None


def test_unregister_noop_for_unknown():
    # Should not raise
    unregister("agent:main:never-registered")


def test_register_overwrites_existing():
    ws1 = MagicMock()
    ws2 = MagicMock()
    register("agent:main:same-key", ws1)
    register("agent:main:same-key", ws2)
    assert get_ws("agent:main:same-key") is ws2
    # Cleanup
    unregister("agent:main:same-key")


# ---------------------------------------------------------------------------
# SessionData and mute state tests
# ---------------------------------------------------------------------------


def test_get_session_returns_session_data():
    mock_ws = MagicMock()
    register("agent:main:session-test", mock_ws, agent_name="Wren")
    session = get_session("agent:main:session-test")
    assert session is not None
    assert session.ws is mock_ws
    assert session.agent_name == "Wren"
    assert session.muted is False
    unregister("agent:main:session-test")


def test_get_session_returns_none_for_unknown():
    assert get_session("agent:main:nope") is None


def test_set_muted_and_is_muted():
    mock_ws = MagicMock()
    register("agent:main:mute-test", mock_ws)
    assert is_muted("agent:main:mute-test") is False

    set_muted("agent:main:mute-test", True)
    assert is_muted("agent:main:mute-test") is True

    set_muted("agent:main:mute-test", False)
    assert is_muted("agent:main:mute-test") is False

    unregister("agent:main:mute-test")


def test_is_muted_returns_false_for_unknown():
    assert is_muted("agent:main:no-session") is False


def test_set_muted_noop_for_unknown():
    # Should not raise
    set_muted("agent:main:no-session", True)


def test_set_timers():
    mock_ws = MagicMock()
    mock_timers = MagicMock()
    register("agent:main:timer-test", mock_ws)
    set_timers("agent:main:timer-test", mock_timers)
    session = get_session("agent:main:timer-test")
    assert session.timers is mock_timers
    unregister("agent:main:timer-test")


# ---------------------------------------------------------------------------
# should_unmute tests
# ---------------------------------------------------------------------------


def test_should_unmute_by_agent_name():
    mock_ws = MagicMock()
    register("agent:main:unmute-name", mock_ws, agent_name="Wren")

    assert should_unmute("agent:main:unmute-name", "Hey Wren, are you there?") is True
    assert should_unmute("agent:main:unmute-name", "wren") is True
    assert should_unmute("agent:main:unmute-name", "WREN can you hear me") is True

    unregister("agent:main:unmute-name")


def test_should_unmute_by_keyword():
    mock_ws = MagicMock()
    register("agent:main:unmute-kw", mock_ws)

    assert should_unmute("agent:main:unmute-kw", "unmute") is True
    assert should_unmute("agent:main:unmute-kw", "you can talk now") is True
    assert should_unmute("agent:main:unmute-kw", "start talking") is True
    assert should_unmute("agent:main:unmute-kw", "I need you to help") is True

    unregister("agent:main:unmute-kw")


def test_should_unmute_case_insensitive():
    mock_ws = MagicMock()
    register("agent:main:unmute-case", mock_ws, agent_name="Wren")

    assert should_unmute("agent:main:unmute-case", "UNMUTE") is True
    assert should_unmute("agent:main:unmute-case", "You Can Talk") is True
    assert should_unmute("agent:main:unmute-case", "Hey WREN") is True

    unregister("agent:main:unmute-case")


def test_should_unmute_false_for_random_text():
    mock_ws = MagicMock()
    register("agent:main:unmute-no", mock_ws, agent_name="Wren")

    assert should_unmute("agent:main:unmute-no", "hello there") is False
    assert should_unmute("agent:main:unmute-no", "what's the weather") is False

    unregister("agent:main:unmute-no")


def test_should_unmute_name_word_boundary():
    """Agent name should match on word boundaries, not substrings."""
    mock_ws = MagicMock()
    register("agent:main:unmute-boundary", mock_ws, agent_name="Wren")

    # "Wren" as a standalone word should match
    assert should_unmute("agent:main:unmute-boundary", "Hey Wren") is True
    # "Wren" embedded in another word should NOT match
    assert should_unmute("agent:main:unmute-boundary", "Lawrence") is False

    unregister("agent:main:unmute-boundary")


def test_should_unmute_returns_false_for_unknown_session():
    assert should_unmute("agent:main:ghost", "Hey Wren") is False


def test_should_unmute_no_agent_name_keyword_only():
    """When no agent name is set, only keywords trigger unmute."""
    mock_ws = MagicMock()
    register("agent:main:unmute-noname", mock_ws)

    assert should_unmute("agent:main:unmute-noname", "unmute") is True
    assert should_unmute("agent:main:unmute-noname", "Hey Wren") is False

    unregister("agent:main:unmute-noname")
