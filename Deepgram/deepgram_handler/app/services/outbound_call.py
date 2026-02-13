"""Outbound voice call service via deepclaw-control proxy.

Initiates outbound Twilio calls through the control plane and stores
call context (purpose, destination) so the outbound webhook can configure
the Deepgram Voice Agent session when the callee answers.
"""

import uuid

import httpx

from app.config import get_settings

# In-memory store for outbound call context, keyed by session_id.
# Populated when a call is initiated, consumed when the callee answers.
_outbound_calls: dict[str, dict] = {}


async def make_call(
    to: str,
    purpose: str = "",
) -> dict:
    """Initiate an outbound voice call through the deepclaw-control proxy.

    The control plane owns the caller ID — the instance never specifies a
    ``from`` number.

    Parameters
    ----------
    to:
        E.164 destination phone number.
    purpose:
        Brief description of the call's purpose.  Becomes the outbound
        agent's prompt instructions.

    Returns
    -------
    dict
        JSON response from the control plane with ``session_id`` added.

    Raises
    ------
    ValueError
        If ``TWILIO_PROXY_URL`` is empty or not configured.
    httpx.HTTPStatusError
        If the control plane returns a non-2xx status code.
    """
    settings = get_settings()
    proxy_url = settings.TWILIO_PROXY_URL

    if not proxy_url:
        raise ValueError(
            "TWILIO_PROXY_URL is not configured. "
            "Set the environment variable to the deepclaw-control base URL."
        )

    session_id = f"outbound-{uuid.uuid4().hex[:12]}"
    callback_url = f"{settings.PUBLIC_URL}/twilio/outbound?sid={session_id}"

    # Store context for the outbound webhook to use when callee answers
    _outbound_calls[session_id] = {"purpose": purpose, "to": to}

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{proxy_url}/api/voice/call",
                json={"to": to, "url": callback_url},
            )
            resp.raise_for_status()
            result = resp.json()
            result["session_id"] = session_id
            return result
    except Exception:
        # Clean up stored context on failure
        _outbound_calls.pop(session_id, None)
        raise


def get_outbound_context(session_id: str) -> dict | None:
    """Pop and return the stored context for an outbound call.

    Returns ``None`` if the session_id is unknown (e.g. already consumed
    or the process restarted).
    """
    return _outbound_calls.pop(session_id, None)
