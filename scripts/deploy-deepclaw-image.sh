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

echo "==> Capturing image reference from deployed machines..."
IMAGE=$(fly machines list -a "$FLY_APP" --json | jq -r '.[0] | "\(.image_ref.registry)/\(.image_ref.repository):\(.image_ref.tag)"')
if [ -z "$IMAGE" ] || [ "$IMAGE" = "null" ]; then
  echo "ERROR: Could not extract image reference from machines" >&2
  exit 1
fi
echo "    Image: $IMAGE"

echo "==> Destroying default machines created by fly deploy..."
MACHINE_IDS=$(fly machines list -a "$FLY_APP" --json | jq -r '.[].id')
for id in $MACHINE_IDS; do
  echo "    Destroying machine $id..."
  fly machines destroy "$id" -a "$FLY_APP" --force
done

echo ""
echo "==> Updating control plane secret..."
fly secrets set OPENCLAW_IMAGE="$IMAGE" -a deepclaw-control
echo "==> Done. OPENCLAW_IMAGE set to $IMAGE"
