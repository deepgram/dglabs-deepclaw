#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

pnpm build
pnpm ui:build
docker build -t openclaw:local .
docker compose up -d openclaw-gateway
