"""Session registry mapping OpenClaw session keys to Deepgram WebSocket connections.

Allows the /v1/chat/completions proxy to inject filler phrases into
active Deepgram Voice Agent sessions when think responses are slow.
"""

from __future__ import annotations

from typing import Any

_active_sessions: dict[str, Any] = {}


def register(session_key: str, dg_ws: Any) -> None:
    """Register a Deepgram WebSocket for a session key."""
    _active_sessions[session_key] = dg_ws


def unregister(session_key: str) -> None:
    """Remove a session key from the registry."""
    _active_sessions.pop(session_key, None)


def get_ws(session_key: str) -> Any | None:
    """Look up the Deepgram WebSocket for a session key."""
    return _active_sessions.get(session_key)
