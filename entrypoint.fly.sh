#!/bin/sh
set -e

# Default gateway token if not injected by control plane
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-openclaw-gateway-token}"
export OPENCLAW_GATEWAY_TOKEN

exec "$@"
