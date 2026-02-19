"""SMS sender registry: track who texted in so status updates can auto-route back."""

import time

# session_key → {"phone": str, "twilio_number": str, "last_update": float}
_senders: dict[str, dict] = {}

# General-purpose rate-limit timestamps (works for any session: SMS or voice)
_rate_timestamps: dict[str, float] = {}


def register_sender(session_key: str, phone: str, twilio_number: str) -> None:
    """Record (or refresh) the phone number and Twilio number for a session."""
    entry = _senders.get(session_key)
    if entry:
        entry["phone"] = phone
        entry["twilio_number"] = twilio_number
    else:
        _senders[session_key] = {"phone": phone, "twilio_number": twilio_number, "last_update": 0.0}


def get_sender(session_key: str) -> tuple[str | None, str | None]:
    """Return ``(phone, twilio_number)`` for *session_key*, or ``(None, None)``."""
    entry = _senders.get(session_key)
    if not entry:
        return None, None
    return entry["phone"], entry["twilio_number"]


def check_rate_limit(session_key: str, cooldown: float = 10.0) -> tuple[bool, float]:
    """Check whether a status update is allowed for *session_key*.

    Returns ``(allowed, wait_seconds)``.  If *allowed* is ``False``,
    *wait_seconds* tells the caller how long until the next update is OK.
    On success the timestamp is updated automatically.
    """
    entry = _senders.get(session_key)
    if not entry:
        return False, 0.0

    now = time.monotonic()
    elapsed = now - entry["last_update"]
    if elapsed < cooldown:
        return False, round(cooldown - elapsed, 1)

    entry["last_update"] = now
    return True, 0.0


def was_recently_updated(session_key: str, window: float = 15.0) -> bool:
    """Return ``True`` if a status update was sent for *session_key* within *window* seconds.

    Used by the SMS webhook to suppress the holding message when the agent
    already sent a ``status_update`` during the current request.
    """
    last = _rate_timestamps.get(session_key, 0.0)
    if last == 0.0:
        return False
    return (time.monotonic() - last) < window


def check_general_rate_limit(session_key: str, cooldown: float = 10.0) -> tuple[bool, float]:
    """Channel-agnostic rate limit for status updates.

    Works for any session key (SMS or voice).  Uses a separate timestamp
    dict so it doesn't interfere with the SMS-specific ``check_rate_limit``.

    Returns ``(allowed, wait_seconds)``.
    """
    now = time.monotonic()
    last = _rate_timestamps.get(session_key, 0.0)
    elapsed = now - last
    if elapsed < cooldown:
        return False, round(cooldown - elapsed, 1)

    _rate_timestamps[session_key] = now
    return True, 0.0
