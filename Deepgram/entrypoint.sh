#!/bin/sh
set -eu

# Ensure OpenClaw directory exists on the persistent volume
mkdir -p /home/node/.openclaw

# Default ANTHROPIC_BASE_URL to Anthropic's API if not set by control plane
# (deploy machines created by `fly deploy` don't have control-plane env vars)
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"

# Resolve env vars in config template on every startup
# (env vars change when pool machines are claimed and restarted)
echo "Resolving OpenClaw config from template..."
envsubst < /seed-data/.openclaw/openclaw.json > /home/node/.openclaw/openclaw.json

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
