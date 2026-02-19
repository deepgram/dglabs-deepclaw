#!/bin/sh
set -eu

# --- Config ---
GATEWAY_PORT=18789
MAX_BACKOFF=30
STABLE_THRESHOLD=60  # seconds before resetting backoff
POLL_INTERVAL=5

# --- Setup ---

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

# --- Process management ---

GATEWAY_PID=""
UVICORN_PID=""

cleanup() {
  echo "Received signal, shutting down..."
  [ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" 2>/dev/null || true
  [ -n "$UVICORN_PID" ] && kill "$UVICORN_PID" 2>/dev/null || true
  wait
  exit 0
}
trap cleanup TERM INT

wait_for_gateway() {
  echo "Waiting for OpenClaw gateway to be ready..."
  i=0
  while [ "$i" -lt 90 ]; do
    if node -e "const s=require('net').connect($GATEWAY_PORT,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; then
      echo "OpenClaw gateway is ready"
      return 0
    fi
    if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
      echo "ERROR: OpenClaw gateway process died during startup"
      return 1
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "ERROR: OpenClaw gateway did not become ready in 90s"
  return 1
}

run_gateway() {
  backoff=1
  while true; do
    start_time=$(date +%s)
    echo "Starting OpenClaw gateway..."
    node /app/dist/index.js gateway --bind lan --port $GATEWAY_PORT &
    GATEWAY_PID=$!

    # On first start, wait for it to be ready
    if [ "$backoff" -eq 1 ]; then
      if ! wait_for_gateway; then
        exit 1
      fi
    fi

    # Wait for gateway to exit
    wait "$GATEWAY_PID" || true
    exit_code=$?
    elapsed=$(( $(date +%s) - start_time ))

    echo "OpenClaw gateway exited (code=$exit_code, ran ${elapsed}s)"

    # Reset backoff if it ran long enough (one-off crash, not a crash loop)
    if [ "$elapsed" -ge "$STABLE_THRESHOLD" ]; then
      backoff=1
    fi

    echo "Restarting gateway in ${backoff}s..."
    sleep "$backoff"

    # Exponential backoff: 1 → 2 → 4 → ... → MAX_BACKOFF
    backoff=$((backoff * 2))
    if [ "$backoff" -gt "$MAX_BACKOFF" ]; then
      backoff=$MAX_BACKOFF
    fi
  done
}

# Start gateway supervisor in background
run_gateway &
MONITOR_PID=$!

# Give gateway time for initial startup before starting uvicorn
# wait_for_gateway is called inside run_gateway on first iteration;
# wait for the monitor to get past that point
sleep 2
# Verify gateway came up by checking the port ourselves
i=0
while [ "$i" -lt 90 ]; do
  if node -e "const s=require('net').connect($GATEWAY_PORT,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$MONITOR_PID" 2>/dev/null; then
    echo "ERROR: Gateway monitor exited during startup"
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$i" -eq 90 ]; then
  echo "ERROR: OpenClaw gateway did not become ready in 90s"
  exit 1
fi

# Start uvicorn in background
echo "Starting Twilio proxy..."
/twilio-proxy/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --app-dir /twilio-proxy &
UVICORN_PID=$!

echo "All processes started (gateway monitor=$MONITOR_PID, uvicorn=$UVICORN_PID)"

# Poll both processes — exit if either dies
while true; do
  if ! kill -0 "$UVICORN_PID" 2>/dev/null; then
    echo "ERROR: Uvicorn died, exiting"
    kill "$MONITOR_PID" 2>/dev/null || true
    # Wait briefly for cleanup
    sleep 1
    exit 1
  fi
  if ! kill -0 "$MONITOR_PID" 2>/dev/null; then
    echo "ERROR: Gateway monitor died, exiting"
    kill "$UVICORN_PID" 2>/dev/null || true
    sleep 1
    exit 1
  fi
  sleep $POLL_INTERVAL
done
