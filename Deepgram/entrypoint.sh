#!/bin/sh
set -eu

# Ensure OpenClaw directory exists on the persistent volume
mkdir -p /home/node/.openclaw

# Default ANTHROPIC_BASE_URL to Anthropic's API if not set by control plane
# (deploy machines created by `fly deploy` don't have control-plane env vars)
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"

# Resolve env-dependent config values.
# Env vars change when pool machines are claimed and restarted, so secrets
# must be refreshed every startup.  But agent-written config (channels,
# plugins, etc.) lives on the persistent volume and must be preserved.
CONFIG="/home/node/.openclaw/openclaw.json"

if [ ! -f "$CONFIG" ]; then
  echo "First boot — seeding OpenClaw config from template..."
  envsubst < /seed-data/.openclaw/openclaw.json > "$CONFIG"
else
  echo "Updating env-dependent config values (preserving agent changes)..."
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$CONFIG', 'utf8'));

    // Refresh secrets / env-dependent values
    cfg.env = cfg.env || {};
    cfg.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || cfg.env.ANTHROPIC_API_KEY || '';

    cfg.gateway = cfg.gateway || {};
    cfg.gateway.auth = cfg.gateway.auth || {};
    cfg.gateway.auth.mode = 'token';
    cfg.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN || cfg.gateway.auth.token || '';

    cfg.models = cfg.models || {};
    cfg.models.providers = cfg.models.providers || {};
    cfg.models.providers.litellm = cfg.models.providers.litellm || {};
    cfg.models.providers.litellm.baseUrl = process.env.ANTHROPIC_BASE_URL || cfg.models.providers.litellm.baseUrl || '';
    cfg.models.providers.litellm.apiKey = process.env.ANTHROPIC_API_KEY || cfg.models.providers.litellm.apiKey || '';

    fs.writeFileSync('$CONFIG', JSON.stringify(cfg, null, 2) + '\n');
  "
fi

# Seed skills directory (overwrite on every startup to pick up new versions)
if [ -d /seed-data/.openclaw/skills ]; then
  echo "Seeding OpenClaw skills..."
  cp -r /seed-data/.openclaw/skills /home/node/.openclaw/skills
fi

# Start OpenClaw gateway in background
echo "Starting OpenClaw gateway..."
node /app/dist/index.js gateway --bind lan --port 18789 &
OPENCLAW_PID=$!

# Wait for OpenClaw to be ready (up to 90s)
echo "Waiting for OpenClaw gateway to be ready..."
i=0
while [ "$i" -lt 90 ]; do
  if node -e "const s=require('net').connect(18789,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; then
    echo "OpenClaw gateway is ready"
    break
  fi
  if ! kill -0 "$OPENCLAW_PID" 2>/dev/null; then
    echo "ERROR: OpenClaw gateway process died"
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$i" -eq 90 ]; then
  echo "ERROR: OpenClaw gateway did not become ready in 90s"
  exit 1
fi

# Start Twilio proxy in foreground
echo "Starting Twilio proxy..."
exec /twilio-proxy/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --app-dir /twilio-proxy
