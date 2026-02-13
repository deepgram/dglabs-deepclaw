"""Shared helpers for post-call extraction pipeline.

Path resolution, file I/O, transcript formatting, Anthropic API calls,
and JSON response parsing.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

WORKSPACE_DIR = Path.home() / ".openclaw" / "workspace"
SONNET_MODEL = "claude-sonnet-4-5-20250929"
API_URL = "https://api.anthropic.com/v1/messages"
TIMEOUT_S = 30.0
MAX_TOKENS = 1024


@dataclass
class TranscriptEntry:
    timestamp: float
    speaker: str  # "bot" | "user"
    text: str


@dataclass
class CallInfo:
    call_id: str
    phone_number: str
    direction: str  # "inbound" | "outbound"
    ended_at: float
    transcript: list[TranscriptEntry]


def format_transcript(transcript: list[TranscriptEntry]) -> str:
    """Format transcript entries as 'Agent: .../Caller: ...' dialogue."""
    lines = []
    for entry in transcript:
        label = "Agent" if entry.speaker == "bot" else "Caller"
        lines.append(f"{label}: {entry.text}")
    return "\n".join(lines)


def workspace_path(settings, filename: str) -> Path:
    """Resolve a workspace file path for the configured agent."""
    base = WORKSPACE_DIR
    if settings.OPENCLAW_AGENT_ID != "main":
        base = base / settings.OPENCLAW_AGENT_ID
    return base / filename


def read_workspace_file(path: Path) -> str | None:
    """Read a workspace file. Returns None if missing or empty."""
    try:
        content = path.read_text().strip()
        return content or None
    except (FileNotFoundError, PermissionError):
        return None


def write_workspace_file(path: Path, content: str) -> None:
    """Write a workspace file, creating parent directories."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def parse_json_response(raw: str) -> dict | None:
    """Parse a JSON response, stripping code fences if present."""
    if not raw or not raw.strip():
        return None
    text = raw.strip()
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence_match:
        text = fence_match.group(1).strip()
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        logger.warning("Failed to parse JSON response: %s", text[:200])
        return None


async def call_anthropic(
    api_key: str,
    prompt: str,
    system_prompt: str,
    max_tokens: int = MAX_TOKENS,
) -> str | None:
    """Call Claude Sonnet via the Anthropic Messages API.

    Returns the text response, or None on any failure.
    """
    if not api_key:
        return None

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                API_URL,
                headers={
                    "Content-Type": "application/json",
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                },
                json={
                    "model": SONNET_MODEL,
                    "max_tokens": max_tokens,
                    "system": system_prompt,
                    "messages": [{"role": "user", "content": prompt}],
                },
                timeout=TIMEOUT_S,
            )

            if resp.status_code != 200:
                logger.warning("Anthropic API returned %d", resp.status_code)
                return None

            data = resp.json()
            content = data.get("content", [])
            if not content:
                return None

            text = content[0].get("text", "").strip()
            return text or None

    except Exception:
        logger.debug("Anthropic API call failed", exc_info=True)
        return None
