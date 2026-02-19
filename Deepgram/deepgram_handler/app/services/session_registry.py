"""Session registry mapping OpenClaw session keys to Deepgram WebSocket connections.

Allows the /v1/chat/completions proxy to inject filler phrases into
active Deepgram Voice Agent sessions when think responses are slow.
Also tracks mute state for agent pause/resume during multi-party calls.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# Phrases that trigger unmute (case-insensitive, checked as substrings)
_UNMUTE_KEYWORDS: list[str] = [
    "unmute",
    "you can talk",
    "start talking",
    "i need you",
]


@dataclass
class SessionData:
    ws: Any
    muted: bool = False
    agent_name: str | None = None
    timers: Any | None = None
    injector: Any | None = None


_active_sessions: dict[str, SessionData] = {}


def register(session_key: str, dg_ws: Any, agent_name: str | None = None) -> None:
    """Register a Deepgram WebSocket for a session key."""
    _active_sessions[session_key] = SessionData(ws=dg_ws, agent_name=agent_name)


def unregister(session_key: str) -> None:
    """Remove a session key from the registry."""
    _active_sessions.pop(session_key, None)


def get_ws(session_key: str) -> Any | None:
    """Look up the Deepgram WebSocket for a session key."""
    session = _active_sessions.get(session_key)
    return session.ws if session else None


def get_session(session_key: str) -> SessionData | None:
    """Look up the full session data for a session key."""
    return _active_sessions.get(session_key)


def set_muted(session_key: str, muted: bool) -> None:
    """Toggle mute state for a session."""
    session = _active_sessions.get(session_key)
    if session:
        session.muted = muted


def is_muted(session_key: str) -> bool:
    """Check if a session is muted."""
    session = _active_sessions.get(session_key)
    return session.muted if session else False


def set_timers(session_key: str, timers: Any) -> None:
    """Store timers reference in session data."""
    session = _active_sessions.get(session_key)
    if session:
        session.timers = timers


def set_injector(session_key: str, injector: Any) -> None:
    """Store voice status injector reference in session data."""
    session = _active_sessions.get(session_key)
    if session:
        session.injector = injector


def should_unmute(session_key: str, user_text: str) -> bool:
    """Check if user text contains the agent's name or an unmute keyword.

    Uses word-boundary regex for the agent name to avoid false positives
    (e.g. "wren" in "Lawrence" won't match).
    """
    session = _active_sessions.get(session_key)
    if not session:
        return False

    text_lower = user_text.lower()

    # Check agent name with word boundaries
    if session.agent_name:
        pattern = r"\b" + re.escape(session.agent_name.lower()) + r"\b"
        if re.search(pattern, text_lower):
            return True

    # Check unmute keywords
    for keyword in _UNMUTE_KEYWORDS:
        if keyword in text_lower:
            return True

    return False
