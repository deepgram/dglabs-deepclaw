#!/usr/bin/env bash
set -euo pipefail
source .env

APP="deepclaw-instance"
REGION="sjc"
VOLUME_SIZE=2  # GB

echo "==> Creating Fly app: $APP"
fly apps create "$APP" --org deepgram || echo "App already exists, continuing..."

# echo "==> Setting secrets"
# fly secrets set \
#   OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" \
#   DEEPGRAM_API_KEY="$DEEPGRAM_API_KEY" \
#   ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
#   --app "$APP"

echo "==> Creating persistent volume (one per machine, ${VOLUME_SIZE}GB)"
fly volumes create openclaw_data \
  --app "$APP" \
  --region "$REGION" \
  --size "$VOLUME_SIZE" \
  --yes || echo "Volume may already exist, continuing..."

echo "==> Deploying"
fly deploy .. --app "$APP" --config fly.toml

echo "==> Done. Check status with: fly status --app $APP"
