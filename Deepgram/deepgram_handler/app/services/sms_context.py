"""SMS context: detect new vs. known users and build OpenClaw messages."""

from pathlib import Path

USER_MD_PATH = Path.home() / ".openclaw" / "workspace" / "USER.md"

SMS_FORMAT_RULES = "Keep responses concise and conversational for texting. A few sentences max."

NEW_USER_SMS_PROMPT = (
    "You're texting with someone for the first time. "
    "You don't have a name yet — if they ask, say you haven't picked one yet. "
    "Within the first exchange, naturally ask their name. "
    "When someone says 'call me [name]' or 'you can call me [name]', "
    "they are telling you their NAME — not asking you to make a phone call. "
    + SMS_FORMAT_RULES
)

KNOWN_USER_SMS_PROMPT = (
    "You're in a text conversation. "
    "If a request is ambiguous, ask a quick clarifying question before acting. "
    + SMS_FORMAT_RULES
)


def build_sms_messages(content: str | list) -> list[dict]:
    """Build the OpenClaw messages list with the appropriate system prompt.

    Checks USER.md to determine if the user is new or known, and prepends
    the matching system prompt.
    """
    try:
        user_context = USER_MD_PATH.read_text().strip()
    except (FileNotFoundError, PermissionError):
        user_context = ""

    if user_context:
        system = f"{KNOWN_USER_SMS_PROMPT}\n\nHere is what you know about this person:\n{user_context}"
    else:
        system = NEW_USER_SMS_PROMPT

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": content},
    ]
