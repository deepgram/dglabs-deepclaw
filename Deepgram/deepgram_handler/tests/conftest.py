import os

# Set required env vars for tests
os.environ.setdefault("DEEPGRAM_API_KEY", "test-key")
os.environ.setdefault("OPENCLAW_GATEWAY_TOKEN", "test-token")
os.environ.setdefault("TWILIO_PROXY_URL", "http://test-control-plane")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-anthropic-key")
os.environ.setdefault("TIMEZONE", "UTC")
os.environ.setdefault("CALLS_MAX_ENTRIES", "50")
os.environ.setdefault("POST_CALL_EXTRACTION", "true")
