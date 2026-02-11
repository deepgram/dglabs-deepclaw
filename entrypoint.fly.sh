#!/bin/sh
set -e

BOOT_START=$(date +%s%N 2>/dev/null || date +%s)
echo "[entrypoint] boot started at $(date -u +%T.%3N 2>/dev/null || date -u +%T)"

CONFIG_FILE="${OPENCLAW_CONFIG_DIR}/openclaw.json"

# Ensure directories exist
mkdir -p "$OPENCLAW_CONFIG_DIR"
mkdir -p "$OPENCLAW_STATE_DIR"

# Copy the bundled config from the source tree if no config exists yet.
# The source config (config/openclaw.json) has the full product configuration:
# voice-call plugin, skills, agent list, gateway settings, etc.
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -f /app/config/openclaw.json ]; then
    cp /app/config/openclaw.json "$CONFIG_FILE"
    echo "[entrypoint] copied bundled openclaw.json"
  else
    # Fallback: write minimal config
    cat > "$CONFIG_FILE" <<CONF
{
  "gateway": {
    "controlUi": {
      "dangerouslyDisableDeviceAuth": true,
      "allowedOrigins": ["*"],
      "allowInsecureAuth": true
    },
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true }
      }
    },
    "trustedProxies": ["172.16.0.0/12", "fdaa::/16", "0.0.0.0/0"]
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-haiku-4-5-20251001"
      }
    }
  }
}
CONF
    echo "[entrypoint] wrote fallback openclaw.json"
  fi
fi

# Write models.json to the agent dir that ModelRegistry actually reads.
# resolveOpenClawAgentDir() = $OPENCLAW_STATE_DIR/agents/main/agent
# This override-only config (baseUrl, no models array) passes validation and
# applies the LiteLLM proxy URL to all built-in anthropic models.
# IMPORTANT: chmod 444 prevents ensureOpenClawModelsJson() from overwriting
# this file at gateway startup (which would reset baseUrl to api.anthropic.com).
AGENT_DIR="${OPENCLAW_STATE_DIR}/agents/main/agent"
mkdir -p "$AGENT_DIR"
if [ -n "$ANTHROPIC_BASE_URL" ]; then
  # Remove read-only flag from previous run (if container restarted)
  chmod 644 "$AGENT_DIR/models.json" 2>/dev/null || true
  cat > "$AGENT_DIR/models.json" <<MCONF
{
  "providers": {
    "anthropic": {
      "baseUrl": "${ANTHROPIC_BASE_URL}"
    }
  }
}
MCONF
  chmod 444 "$AGENT_DIR/models.json"
  echo "[entrypoint] wrote models.json with baseUrl: $ANTHROPIC_BASE_URL (read-only)"
fi

# Default gateway token if not set via env
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-openclaw-gateway-token}"
export OPENCLAW_GATEWAY_TOKEN

echo "[entrypoint] starting OpenClaw for user: ${DEEPGRAM_USER_ID:-unknown}"

BOOT_END=$(date +%s%N 2>/dev/null || date +%s)
if [ ${#BOOT_START} -gt 10 ] && [ ${#BOOT_END} -gt 10 ]; then
  ENTRYPOINT_MS=$(( (BOOT_END - BOOT_START) / 1000000 ))
  echo "[entrypoint] config setup took ${ENTRYPOINT_MS}ms, handing off to gateway"
else
  echo "[entrypoint] config setup done, handing off to gateway"
fi

exec stdbuf -oL -eL "$@"
