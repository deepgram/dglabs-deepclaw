from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    DEEPGRAM_API_KEY: str
    DEEPGRAM_AGENT_URL: str = "wss://agent.deepgram.com/v1/agent/converse"

    # OpenClaw
    OPENCLAW_GATEWAY_TOKEN: str
    OPENCLAW_AGENT_ID: str = "main"
    PUBLIC_URL: str = "https://deepclaw-instance.fly.dev"

    # Voice agent configuration
    AGENT_LISTEN_MODEL: str = "flux-general-en"
    AGENT_THINK_MODEL: str = "anthropic/claude-haiku-4-5"
    AGENT_VOICE: str = "aura-2-thalia-en"
    AGENT_PROMPT: str = (
        "You are on a phone call with someone for the first time. "
        "You don't have a name yet — if the caller asks, say you haven't picked one yet. "
        "Within the first exchange, naturally ask their name if you don't have it yet. "
        "IMPORTANT: When someone says 'call me [name]' or 'you can call me [name]', "
        "they are telling you their NAME — not asking you to make a phone call. "
        "IMPORTANT: Your responses will be spoken aloud via text-to-speech. Do NOT use any text formatting — "
        "no markdown, no bullet points, no asterisks, no numbered lists, no headers. "
        "Write plain conversational sentences only. "
        "Keep responses brief and conversational (1-2 sentences max). "
        'Do NOT start your response with filler phrases like "Let me check" or "One moment" — '
        "jump straight into the answer."
        "If you are asked to send a text, use the twilio text skill"
    )
    AGENT_GREETING: str = "Hello! How can I help you today?"

    # Control plane proxy URL (for outbound SMS)
    TWILIO_PROXY_URL: str = ""

    # Filler phrases (for voice call dead-air prevention)
    FILLER_THRESHOLD_MS: int = 1500
    FILLER_PHRASES: str = ""
    FILLER_DYNAMIC: bool = True
    ANTHROPIC_API_KEY: str = ""
    ANTHROPIC_BASE_URL: str = "https://api.anthropic.com"

    _DEFAULT_FILLER_PHRASES: list[str] = [
        "Hmm, let me think about that.",
        "Good question, one sec.",
        "Oh interesting, give me a moment.",
        "Let me look into that.",
        "Hmm, let me see.",
        "One moment while I think on that.",
    ]

    @property
    def filler_phrases_list(self) -> list[str]:
        if self.FILLER_PHRASES:
            return [p.strip() for p in self.FILLER_PHRASES.split(",") if p.strip()]
        return self._DEFAULT_FILLER_PHRASES

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache
def get_settings() -> Settings:
    """Return a cached singleton Settings instance."""
    return Settings()
