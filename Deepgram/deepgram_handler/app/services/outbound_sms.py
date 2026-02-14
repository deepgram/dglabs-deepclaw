"""Outbound SMS service.

Supports two modes:
1. **Control plane proxy** — when ``TWILIO_PROXY_URL`` is set, POSTs to the
   deepclaw-control proxy at ``{TWILIO_PROXY_URL}/api/sms/send``.
2. **Direct Twilio API** — when ``TWILIO_PROXY_URL`` is empty, calls the
   Twilio REST API directly using ``TWILIO_ACCOUNT_SID``,
   ``TWILIO_AUTH_TOKEN``, and ``TWILIO_FROM_NUMBER``.
"""

import logging

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)


async def send_sms(
    to: str,
    text: str | None = None,
    from_number: str | None = None,
    media_urls: list[str] | None = None,
) -> dict:
    """Send an outbound SMS.

    Parameters
    ----------
    to:
        E.164 destination phone number.
    text:
        Message body (optional when *media_urls* is provided).
    from_number:
        E.164 sender number.  Falls back to ``TWILIO_FROM_NUMBER`` in
        direct mode or control plane default in proxy mode.
    media_urls:
        Optional list of publicly-reachable media URLs to attach as MMS.

    Returns
    -------
    dict
        JSON response with at least ``{"sid": ..., "status": ...}``.

    Raises
    ------
    ValueError
        If neither proxy nor direct Twilio credentials are configured.
    httpx.HTTPStatusError
        On non-2xx responses from the upstream API.
    """
    settings = get_settings()
    proxy_url = settings.TWILIO_PROXY_URL

    if proxy_url:
        return await _send_via_proxy(proxy_url, to, text, from_number, media_urls)

    return await _send_via_twilio(settings, to, text, from_number, media_urls)


async def _send_via_proxy(
    proxy_url: str,
    to: str,
    text: str | None,
    from_number: str | None,
    media_urls: list[str] | None,
) -> dict:
    """Send SMS through the deepclaw-control proxy."""
    url = f"{proxy_url}/api/sms/send"
    payload: dict = {"to": to, "text": text, "from": from_number}
    if media_urls is not None:
        payload["mediaUrls"] = media_urls

    logger.info(
        "Outbound SMS (proxy): POST %s to=%s text_len=%d from=%s",
        url, to, len(text or ""), from_number or "default",
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json=payload)
        logger.info(
            "Outbound SMS (proxy): response status=%d body=%s",
            resp.status_code, resp.text[:300],
        )
        resp.raise_for_status()
        return resp.json()


async def _send_via_twilio(
    settings,
    to: str,
    text: str | None,
    from_number: str | None,
    media_urls: list[str] | None,
) -> dict:
    """Send SMS directly via the Twilio REST API."""
    if not settings.TWILIO_ACCOUNT_SID or not settings.TWILIO_AUTH_TOKEN:
        raise ValueError(
            "Neither TWILIO_PROXY_URL nor direct Twilio credentials "
            "(TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN) are configured."
        )

    sender = from_number or settings.TWILIO_FROM_NUMBER
    if not sender:
        raise ValueError(
            "No sender number: set TWILIO_FROM_NUMBER or pass from_number."
        )

    url = (
        f"https://api.twilio.com/2010-04-01"
        f"/Accounts/{settings.TWILIO_ACCOUNT_SID}/Messages.json"
    )
    # Twilio accepts repeated MediaUrl keys, so use a list of tuples.
    form_data: list[tuple[str, str]] = [("To", to), ("From", sender)]
    if text:
        form_data.append(("Body", text))
    if media_urls:
        for media_url in media_urls:
            form_data.append(("MediaUrl", media_url))

    logger.info(
        "Outbound SMS (direct): POST %s to=%s text_len=%d from=%s",
        url, to, len(text or ""), sender,
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            url,
            data=form_data,
            auth=(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN),
        )
        logger.info(
            "Outbound SMS (direct): response status=%d body=%s",
            resp.status_code, resp.text[:300],
        )
        resp.raise_for_status()
        return resp.json()
