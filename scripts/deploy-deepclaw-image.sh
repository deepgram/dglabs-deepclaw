#!/usr/bin/env bash
set -euo pipefail

# deploy-deepclaw-image.sh — Build and push the DeepClaw Docker image to Fly.io registry.
#
# This pushes the image that the deepclaw-control control plane uses to create
# per-user machines. `fly deploy` also creates default machines as a side effect —
# those are destroyed immediately since user machines are created on-demand.
#
# Usage:
#   ./scripts/deploy-deepclaw-image.sh
#
# After pushing, update the control plane with the new image tag:
#   fly secrets set OPENCLAW_IMAGE="registry.fly.io/deepclaw-instance:<tag>" -a deepclaw-control
#   # Get the tag: fly releases -a deepclaw-instance --image

FLY_APP="${FLY_APP:-deepclaw-instance}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."
FLY_CONFIG="$REPO_ROOT/fly.deepclaw.toml"

echo "==> Building and pushing DeepClaw image..."
fly deploy "$REPO_ROOT" -a "$FLY_APP" --config "$FLY_CONFIG"

echo "==> Destroying default machines created by fly deploy..."
MACHINE_IDS=$(fly machines list -a "$FLY_APP" --json | jq -r '.[].id')
for id in $MACHINE_IDS; do
  echo "    Destroying machine $id..."
  fly machines destroy "$id" -a "$FLY_APP" --force
done

echo ""
echo "==> Image pushed to registry.fly.io/$FLY_APP"
echo ""
echo "Next step — update the control plane secret with the new tag:"
fly releases -a $FLY_APP --image
fly secrets set OPENCLAW_IMAGE="registry.fly.io/$FLY_APP:<tag>" -a deepclaw-control
echo "  fly releases -a $FLY_APP --image"
echo "  fly secrets set OPENCLAW_IMAGE=\"registry.fly.io/$FLY_APP:<tag>\" -a deepclaw-control"
