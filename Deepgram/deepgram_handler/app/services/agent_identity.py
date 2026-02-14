"""Post-call agent identity extraction — merges into IDENTITY.md.

After the first inbound call (or until any identity field is set),
extracts the agent's self-chosen identity from the transcript via
Claude Sonnet and merges into IDENTITY.md with fill-only semantics.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from app.services.workspace import (
    CallInfo,
    call_anthropic,
    format_transcript,
    parse_json_response,
    read_workspace_file,
    workspace_path,
    write_workspace_file,
)

logger = logging.getLogger(__name__)

GENERIC_NAMES = {
    "voice agent",
    "assistant",
    "ai",
    "ai assistant",
    "bot",
    "agent",
    "helper",
}

IDENTITY_PLACEHOLDERS = {
    "pick something you like",
    "ai? robot? familiar? ghost in the machine? something weirder?",
    "how do you come across? sharp? warm? chaotic? calm?",
    "your signature - pick one that feels right",
    "workspace-relative path, http(s) url, or data uri",
}

IDENTITY_SYSTEM_PROMPT = (
    "Extract the AI agent's self-chosen identity from this phone call transcript. "
    "Focus on how the AGENT introduced or described itself. "
    "Return ONLY a JSON object with fields you can confidently extract. "
    "Return valid JSON only."
)

IDENTITY_PROMPT_TEMPLATE = (
    "Extract the AI agent's self-chosen identity from this phone call transcript.\n"
    "Focus on how the AGENT introduced or described itself -- not the caller.\n\n"
    "Return ONLY a JSON object with fields you can confidently extract from the conversation.\n\n"
    "Fields:\n"
    '- "name": The name the agent used to introduce itself (e.g. "I\'m Ripley")\n'
    '- "creature": How the agent described what it is (e.g. "AI assistant", "voice companion")\n'
    '- "vibe": The agent\'s personality/tone (e.g. "casual and warm", "direct and helpful")\n'
    '- "emoji": Any emoji the agent associated with itself\n\n'
    'The "name" field is the most important:\n'
    "- If the agent introduced itself by name or the caller gave it a name, use that.\n"
    "- If no name was established, PICK a distinctive, personal name -- something like "
    '"Wren", "Ember", "Moss", "Sable". Not generic like "Assistant" or "AI".\n'
    "For other fields, only include them if supported by clear evidence in the transcript.\n"
    "Return valid JSON only, no markdown.\n\n"
    "Transcript:\n{transcript}"
)


@dataclass
class AgentIdentity:
    name: str | None = None
    creature: str | None = None
    vibe: str | None = None
    emoji: str | None = None
    avatar: str | None = None


def _normalize_identity_value(value: str) -> str:
    """Normalize a value for placeholder comparison."""
    n = value.strip()
    n = re.sub(r"^[*_]+|[*_]+$", "", n).strip()
    if n.startswith("(") and n.endswith(")"):
        n = n[1:-1].strip()
    n = n.replace("\u2013", "-").replace("\u2014", "-")
    n = re.sub(r"\s+", " ", n).lower()
    return n


def is_identity_placeholder(value: str) -> bool:
    """Check if a value is a known IDENTITY.md placeholder."""
    return _normalize_identity_value(value) in IDENTITY_PLACEHOLDERS


def _strip_frontmatter(content: str) -> str:
    """Remove YAML frontmatter if present."""
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            return content[end + 3 :].lstrip("\n")
    return content


def parse_identity_md(content: str) -> AgentIdentity:
    """Parse IDENTITY.md markdown into an AgentIdentity."""
    content = _strip_frontmatter(content)
    identity = AgentIdentity()
    lines = content.split("\n")

    for i, line in enumerate(lines):
        cleaned = line.strip().lstrip("- ")
        colon_idx = cleaned.find(":")
        if colon_idx == -1:
            continue
        label = re.sub(r"[*_]", "", cleaned[:colon_idx]).strip().lower()
        value = re.sub(r"^[*_]+|[*_]+$", "", cleaned[colon_idx + 1 :]).strip()

        # Check next line for indented placeholder value
        if not value and i + 1 < len(lines):
            next_line = lines[i + 1].strip()
            if next_line and not next_line.startswith("- **"):
                if is_identity_placeholder(next_line):
                    continue
                value = next_line

        if not value or is_identity_placeholder(value):
            continue

        if label == "name":
            identity.name = value
        elif label == "creature":
            identity.creature = value
        elif label == "vibe":
            identity.vibe = value
        elif label == "emoji":
            identity.emoji = value
        elif label == "avatar":
            identity.avatar = value

    return identity


def identity_has_values(identity: AgentIdentity) -> bool:
    """Check if any identity field has a value."""
    return bool(
        identity.name
        or identity.creature
        or identity.vibe
        or identity.emoji
        or identity.avatar
    )


def merge_agent_identities(
    existing: AgentIdentity, extracted: AgentIdentity
) -> AgentIdentity:
    """Merge extracted identity into existing with fill-only semantics."""
    merged = AgentIdentity(
        name=existing.name,
        creature=existing.creature,
        vibe=existing.vibe,
        emoji=existing.emoji,
        avatar=existing.avatar,  # Never overwritten by extraction
    )
    if not merged.name and extracted.name:
        merged.name = extracted.name
    if not merged.creature and extracted.creature:
        merged.creature = extracted.creature
    if not merged.vibe and extracted.vibe:
        merged.vibe = extracted.vibe
    if not merged.emoji and extracted.emoji:
        merged.emoji = extracted.emoji
    # avatar is never set by extraction
    return merged


def serialize_identity_md(identity: AgentIdentity) -> str:
    """Serialize an AgentIdentity back to IDENTITY.md markdown."""
    lines = [
        "# IDENTITY.md - Who Am I?",
        "",
        "_Fill this in during your first conversation. Make it yours._",
        "",
        f"- **Name:** {identity.name or ''}",
        f"- **Creature:** {identity.creature or ''}",
        f"- **Vibe:** {identity.vibe or ''}",
        f"- **Emoji:** {identity.emoji or ''}",
        f"- **Avatar:** {identity.avatar or ''}",
        "",
        "---",
        "",
        "This isn't just metadata. It's the start of figuring out who you are.",
        "",
    ]
    return "\n".join(lines)


async def extract_agent_identity(settings, call_info: CallInfo) -> None:
    """Extract agent identity from call transcript and merge into IDENTITY.md."""
    try:
        transcript_text = format_transcript(call_info.transcript)
        if not transcript_text:
            return

        identity_path = workspace_path(settings, "IDENTITY.md")
        existing_content = read_workspace_file(identity_path)
        existing_identity = (
            parse_identity_md(existing_content) if existing_content else AgentIdentity()
        )

        if identity_has_values(existing_identity):
            logger.info(
                "[post-call] Skipping agent identity extraction: identity already populated"
            )
            return

        prompt = IDENTITY_PROMPT_TEMPLATE.format(transcript=transcript_text)
        raw = await call_anthropic(
            settings.OPENCLAW_GATEWAY_TOKEN,
            prompt,
            IDENTITY_SYSTEM_PROMPT,
        )

        if not raw:
            logger.warning("[post-call] Agent identity extraction returned no result")
            return

        data = parse_json_response(raw)
        if not data:
            return

        extracted = AgentIdentity(
            name=data.get("name"),
            creature=data.get("creature"),
            vibe=data.get("vibe"),
            emoji=data.get("emoji"),
        )

        # Discard generic names
        if extracted.name and extracted.name.lower() in GENERIC_NAMES:
            logger.info("[post-call] Discarding generic agent name: %s", extracted.name)
            extracted.name = None

        merged = merge_agent_identities(existing_identity, extracted)
        write_workspace_file(identity_path, serialize_identity_md(merged))

        logger.info("[post-call] Agent identity updated in IDENTITY.md")

    except Exception:
        logger.exception("[post-call] Failed to extract agent identity")
