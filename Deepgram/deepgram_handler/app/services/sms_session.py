"""SMS session: shared delivery state for concurrent SMS requests.

Each inbound SMS day-session (keyed by ``agent:{id}:sms-YYYYMMDD``) gets a
single ``_SMSSession`` object.  All concurrent request handlers for that key
reference the same object, eliminating duplicate final deliveries.

Delivery paths:
- **Fast path (< 12s)**: TwiML reply from the SSE HTTP stream.
- **Slow path (> 12s)**: Safety-delayed task delivers via outbound SMS.
- **WS**: Only used for silence-detected intermediates (``chat.delta``)
  and observability logging (``agent`` events).
"""

from __future__ import annotations

import asyncio
import logging
import time

from app.services.outbound_sms import send_sms
from app.services.sms_context import truncate_reply
from app.services.sms_sender_registry import check_general_rate_limit

logger = logging.getLogger(__name__)

# Minimum cooldown between intermediate SMS updates (seconds).
INTERMEDIATE_COOLDOWN = 15.0

# Seconds of silence (no chat.delta) before we send the accumulated text
# as an intermediate SMS.
SILENCE_THRESHOLD = 5.0

# How long to keep a session object alive after final delivery (seconds).
SESSION_TTL = 120.0


def _extract_chat_text(payload: dict) -> str:
    """Extract text from a ``chat`` event payload (delta or final)."""
    msg = payload.get("message")
    if not isinstance(msg, dict):
        return ""
    for part in msg.get("content", []):
        if isinstance(part, dict) and part.get("type") == "text":
            return part.get("text", "")
    return ""


class _SMSSession:
    """Shared delivery state for one SMS day-session."""

    def __init__(self, session_key: str, from_number: str, twilio_number: str) -> None:
        self.session_key = session_key
        self.from_number = from_number
        self.twilio_number = twilio_number

        # Delivery flags
        self.final_delivered: bool = False
        self.twiml_replied: bool = False
        self._agent_delivered: bool = False

        # Intermediate text tracking
        self.last_delta_text: str = ""
        self.last_sent_text: str = ""
        self._sent_texts: list[str] = []

        # Per-segment tracking (populated from WS events)
        self._response_segments: list[str] = []

        # Timers / tasks
        self.silence_handle: asyncio.TimerHandle | None = None
        self._safety_task: asyncio.Task | None = None
        self._cleanup_handle: asyncio.TimerHandle | None = None

    # -- WS callback ----------------------------------------------------------

    async def on_gateway_event(self, event_name: str, payload: dict) -> None:
        """Gateway WS callback.  Handles ``chat.delta`` and ``agent`` events."""
        if event_name == "chat":
            state = payload.get("state")

            if state == "delta":
                text = _extract_chat_text(payload)
                if text:
                    prev_len = len(self.last_delta_text)
                    continues = text.startswith(self.last_delta_text[:20]) if self.last_delta_text else True
                    logger.debug(
                        "[sms-session] chat.delta: len=%d prev_len=%d continues=%s text=%s",
                        len(text), prev_len, continues, text[:80],
                    )
                    self.last_delta_text = text
                    # Reset silence timer — text is still flowing
                    self._cancel_silence()
                    loop = asyncio.get_running_loop()
                    self.silence_handle = loop.call_later(
                        SILENCE_THRESHOLD,
                        lambda: asyncio.create_task(self._send_silence_intermediate()),
                    )

            elif state == "final":
                # Finalize the last response segment.
                self._cancel_silence()
                final_text = _extract_chat_text(payload).strip()
                if final_text:
                    self._save_segment(final_text)
                elif self.last_delta_text.strip():
                    self._save_segment(self.last_delta_text.strip())
                self.last_delta_text = ""
                logger.info(
                    "[sms-session] chat.final received for %s (%d segments captured)",
                    self.from_number,
                    len(self._response_segments),
                )

        elif event_name == "agent":
            stream = payload.get("stream")
            data = payload.get("data", {})
            if stream == "tool" and data.get("phase") == "start":
                # Tool call starting — finalize the current response segment.
                if self.last_delta_text.strip():
                    self._save_segment(self.last_delta_text.strip())
                    self.last_delta_text = ""
                logger.info("[sms-session] tool call: %s", data.get("name", "?"))
            elif stream == "lifecycle" and data.get("phase") in ("end", "error"):
                logger.info("[sms-session] lifecycle: %s", data.get("phase"))
            else:
                # Demote noisy token-level assistant events to DEBUG
                log = logger.debug if stream == "assistant" else logger.info
                log(
                    "[sms-session] agent event: stream=%s phase=%s name=%s",
                    stream,
                    data.get("phase"),
                    data.get("name"),
                )

    # -- Silence-detected intermediate ----------------------------------------

    async def _send_silence_intermediate(self) -> None:
        """Fired when text generation pauses (tool call likely running)."""
        if self.final_delivered or self.twiml_replied:
            return
        text = self.last_delta_text.strip()
        if not text or len(text) < 20:
            return
        # Only send if text ends at a sentence boundary.
        if text[-1] not in ".!?":
            for i in range(len(text) - 1, -1, -1):
                if text[i] in ".!?":
                    text = text[: i + 1]
                    break
            else:
                logger.info(
                    "[sms-session] silence-intermediate skipped for %s — no sentence boundary",
                    self.from_number,
                )
                return
        # Dedup
        if text == self.last_sent_text:
            return
        allowed, wait = check_general_rate_limit(self.session_key, cooldown=INTERMEDIATE_COOLDOWN)
        if not allowed:
            logger.info(
                "[sms-session] silence-intermediate throttled for %s (wait %.1fs)",
                self.from_number,
                wait,
            )
            return
        self.last_sent_text = text
        self._sent_texts.append(text)
        short = truncate_reply(text)
        try:
            await send_sms(to=self.from_number, text=short, from_number=self.twilio_number or None)
            logger.info("[sms-session] silence-intermediate sent to %s: %s", self.from_number, short[:120])
        except Exception:
            logger.warning("[sms-session] silence-intermediate failed for %s", self.from_number, exc_info=True)

    # -- Safety-delayed delivery ----------------------------------------------

    def start_safety_task(self, http_task: asyncio.Task[str]) -> None:
        """Cancel any existing safety task and start a new one.

        This is the core fix: only one safety task per session, new cancels old.
        """
        self._cancel_safety_task()
        self._safety_task = asyncio.create_task(self._safety_delayed(http_task))

    async def _safety_delayed(self, http_task: asyncio.Task[str]) -> None:
        """Await the HTTP SSE stream and deliver remaining segments as SMS."""
        try:
            full_reply = await http_task
            if not full_reply or self.final_delivered or self.twiml_replied or self._agent_delivered:
                if not full_reply:
                    logger.info("[sms-session] safety-delayed skipped for %s — empty reply", self.from_number)
                else:
                    logger.info(
                        "[sms-session] safety-delayed skipped for %s (final=%s, twiml=%s, agent=%s)",
                        self.from_number,
                        self.final_delivered,
                        self.twiml_replied,
                        self._agent_delivered,
                    )
                return

            self.final_delivered = True

            # Prefer WS-captured segments for per-message delivery.
            # Fall back to the monolithic SSE reply with substring stripping.
            if self._response_segments:
                segments = self._response_segments
            else:
                reply = full_reply
                for sent in self._sent_texts:
                    reply = reply.replace(sent, "", 1)
                segments = [reply.strip()]

            sent_count = 0
            for seg in segments:
                text = self._strip_already_sent(seg)
                if not text or len(text) < 20:
                    continue
                text = truncate_reply(text)
                try:
                    if sent_count > 0:
                        await asyncio.sleep(0.5)
                    await send_sms(to=self.from_number, text=text, from_number=self.twilio_number or None)
                    sent_count += 1
                    logger.info("[sms-session] safety-delayed sent to %s: %s", self.from_number, text[:120])
                except Exception:
                    logger.warning("[sms-session] safety-delayed send failed for %s", self.from_number, exc_info=True)

            if sent_count == 0:
                logger.info("[sms-session] safety-delayed: all segments already sent for %s", self.from_number)
        except asyncio.CancelledError:
            logger.info("[sms-session] safety-delayed cancelled for %s", self.from_number)
        except Exception:
            logger.exception("[sms-session] safety-delayed failed for %s", self.from_number)
        finally:
            self._cancel_silence()
            self._unsubscribe_ws()
            self.schedule_cleanup()

    def _strip_already_sent(self, segment: str) -> str:
        """Remove text from a segment that was already sent as an intermediate."""
        segment = segment.strip()
        for sent in self._sent_texts:
            if segment == sent:
                return ""
            if segment.startswith(sent):
                return segment[len(sent):].strip()
        return segment

    # -- Lifecycle ------------------------------------------------------------

    def mark_twiml_replied(self) -> None:
        """Mark that the TwiML fast-path delivered a reply."""
        self.twiml_replied = True
        self._cancel_silence()
        self._unsubscribe_ws()
        self.schedule_cleanup()

    def mark_error(self) -> None:
        """Clean up after an error in the handler."""
        self._cancel_silence()
        self._cancel_safety_task()
        self._unsubscribe_ws()
        self.schedule_cleanup()

    def reset_for_new_request(self) -> None:
        """Reset delivery flags for a new inbound SMS.

        Called each time ``get_or_create_session`` is invoked so the session
        expects a fresh reply cycle.
        """
        self.final_delivered = False
        self.twiml_replied = False
        self._agent_delivered = False
        self._sent_texts.clear()
        self._response_segments.clear()
        self._cancel_silence()
        # Cancel any pending cleanup — we're still active
        if self._cleanup_handle is not None:
            self._cleanup_handle.cancel()
            self._cleanup_handle = None

    def schedule_cleanup(self) -> None:
        """Remove this session from the registry after TTL."""
        if self._cleanup_handle is not None:
            self._cleanup_handle.cancel()
        try:
            loop = asyncio.get_running_loop()
            self._cleanup_handle = loop.call_later(SESSION_TTL, _remove_session, self.session_key)
        except RuntimeError:
            # No running loop (e.g. during shutdown) — just remove immediately
            _remove_session(self.session_key)

    # -- Internal helpers -----------------------------------------------------

    def _save_segment(self, text: str) -> None:
        """Append a response segment, deduplicating consecutive identical texts.

        The gateway often fires duplicate events (e.g. two ``chat.final`` for
        the same run), which would otherwise cause the same segment to be sent
        as multiple SMS messages.
        """
        if not self._response_segments or self._response_segments[-1] != text:
            self._response_segments.append(text)

    def _cancel_silence(self) -> None:
        if self.silence_handle is not None:
            self.silence_handle.cancel()
            self.silence_handle = None

    def _cancel_safety_task(self) -> None:
        if self._safety_task is not None and not self._safety_task.done():
            self._safety_task.cancel()
            self._safety_task = None

    def _unsubscribe_ws(self) -> None:
        from app.services.gateway_ws import get_gateway_ws

        gw = get_gateway_ws()
        if gw:
            asyncio.create_task(gw.unsubscribe(self.session_key))


# -- Session registry ---------------------------------------------------------

_sessions: dict[str, _SMSSession] = {}


def get_or_create_session(session_key: str, from_number: str, twilio_number: str) -> _SMSSession:
    """Return existing session or create a new one.

    Always calls ``reset_for_new_request()`` so each inbound SMS starts with
    clean delivery flags.
    """
    session = _sessions.get(session_key)
    if session is None:
        session = _SMSSession(session_key, from_number, twilio_number)
        _sessions[session_key] = session
    else:
        # Update phone numbers in case they changed
        session.from_number = from_number
        session.twilio_number = twilio_number
    session.reset_for_new_request()
    return session


def notify_agent_sms(to_number: str) -> None:
    """Mark active sessions when the agent sends an outbound SMS directly.

    Called by ``/actions/send-sms`` after a successful delivery.  Tells the
    safety-delayed path that the agent already handled delivery, so it should
    not send stale intermediate text.
    """
    for session in _sessions.values():
        if session.from_number == to_number:
            session._agent_delivered = True
            logger.info("[sms-session] agent delivery noted for %s", to_number)


def _remove_session(session_key: str) -> None:
    """Remove session from registry (called by cleanup timer)."""
    _sessions.pop(session_key, None)
