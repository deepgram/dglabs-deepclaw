"""Post-call summary extraction — appends entries to CALLS.md.

After each inbound call, summarizes the conversation via Claude Sonnet
and appends a timestamped entry to the agent's CALLS.md file.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from app.services.workspace import (
    CallInfo,
    call_anthropic,
    format_transcript,
    read_workspace_file,
    workspace_path,
    write_workspace_file,
)

logger = logging.getLogger(__name__)

SUMMARY_SYSTEM_PROMPT = (
    "Summarize this phone call concisely. Include: who called, what was discussed, "
    "any specific requests or topics, any action items or outcomes, and anything the "
    "caller might appreciate being remembered next time. Write plain text only."
)


def trim_call_entries(content: str, max_entries: int) -> str:
    """Keep the header and the last N call entries."""
    parts = re.split(r"(?=^### )", content, flags=re.MULTILINE)
    header = parts[0] if parts else "# Call History\n\n"
    entries = parts[1:]

    if len(entries) <= max_entries:
        return content

    kept = entries[-max_entries:]
    return header.rstrip() + "\n\n" + "".join(kept).rstrip() + "\n"


def _format_timestamp(ended_at: float, tz_name: str) -> str:
    """Format a timestamp for CALLS.md entry heading."""
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(tz_name)
    except (ImportError, KeyError):
        tz = timezone.utc

    dt = datetime.fromtimestamp(ended_at, tz=tz)
    return dt.strftime("%m/%d/%Y, %-I:%M %p")


async def generate_call_summary(settings, call_info: CallInfo) -> None:
    """Extract a call summary and append it to CALLS.md."""
    try:
        transcript_text = format_transcript(call_info.transcript)
        if not transcript_text:
            return

        prompt = (
            f"Summarize this phone call concisely.\n"
            f"Include: who called, what was discussed, any specific requests or topics (name them),\n"
            f"any action items or outcomes, and anything the caller might appreciate being remembered next time.\n"
            f"Write plain text only -- no markdown formatting, no bullet points.\n\n"
            f"Call direction: {call_info.direction}\n"
            f"Phone number: {call_info.phone_number}\n\n"
            f"Transcript:\n{transcript_text}"
        )

        summary = await call_anthropic(
            settings.ANTHROPIC_API_KEY,
            prompt,
            SUMMARY_SYSTEM_PROMPT,
            max_tokens=500,
        )

        if not summary:
            logger.warning("[post-call] Call summary extraction returned no result")
            return

        calls_path = workspace_path(settings, "CALLS.md")
        existing = read_workspace_file(calls_path) or "# Call History\n"

        timestamp = _format_timestamp(call_info.ended_at, settings.TIMEZONE)
        entry = f"### {timestamp} -- {call_info.phone_number} ({call_info.direction})\n{summary}\n"
        updated = existing.rstrip() + "\n\n" + entry

        trimmed = trim_call_entries(updated, settings.CALLS_MAX_ENTRIES)
        write_workspace_file(calls_path, trimmed)

        logger.info("[post-call] Call summary written to CALLS.md")

    except Exception:
        logger.exception("[post-call] Failed to generate call summary")
