from unittest.mock import MagicMock

from app.services.session_registry import get_ws, register, unregister


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
