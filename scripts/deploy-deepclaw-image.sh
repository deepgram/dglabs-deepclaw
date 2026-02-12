#!/usr/bin/env bash
set -euo pipefail

# deploy-deepclaw-image.sh — Tear down stale state, then build and push the
# DeepClaw Docker image to Fly.io registry.
#
# Steps:
#   1. Destroy old deepclaw-instance machines
#   2. Delete LiteLLM virtual keys
#   3. Truncate DB tables (users, machines, api_keys, pool_machines)
#   4. Build and push the new image via fly deploy
#   5. Capture image reference, destroy default machines, update control plane
#
# Usage:
#   ./scripts/deploy-deepclaw-image.sh [prefix]
#
# The prefix defaults to "deepclaw". App names are derived as:
#   {prefix}-control, {prefix}-instance, {prefix}-litellm

PREFIX="${1:-deepclaw}"
CONTROL_APP="${PREFIX}-control"
INSTANCE_APP="${FLY_APP:-${PREFIX}-instance}"
LITELLM_APP="${PREFIX}-litellm"
LITELLM_URL="https://${LITELLM_APP}.fly.dev"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."
FLY_CONFIG="$REPO_ROOT/fly.deepclaw.toml"

echo "=== DeepClaw Deploy — prefix: $PREFIX ==="
echo "  Control:  $CONTROL_APP"
echo "  Instance: $INSTANCE_APP"
echo "  LiteLLM:  $LITELLM_URL"
echo ""

# ── Step 1: Destroy old instance machines ────────────────────────────

echo "==> Step 1: Destroying old $INSTANCE_APP machines..."
OLD_MACHINES=$(fly machines list -a "$INSTANCE_APP" --json 2>/dev/null || echo "[]")
OLD_IDS=$(echo "$OLD_MACHINES" | jq -r '.[].id // empty')
if [ -z "$OLD_IDS" ]; then
  echo "    No existing machines found. Skipping."
else
  for id in $OLD_IDS; do
    name=$(echo "$OLD_MACHINES" | jq -r ".[] | select(.id==\"$id\") | .name // \"$id\"")
    echo "    Destroying $name ($id)..."
    fly machines destroy "$id" -a "$INSTANCE_APP" --force || echo "    WARN: failed to destroy $id"
  done
fi

# ── Step 2: Delete LiteLLM virtual keys ─────────────────────────────

echo ""
echo "==> Step 2: Deleting LiteLLM virtual keys..."
MASTER_KEY=""
RAW=$(fly ssh console -a "$CONTROL_APP" -C "printenv LITELLM_MASTER_KEY" 2>/dev/null || true)
for line in $RAW; do
  if [[ "$line" == sk-* ]]; then
    MASTER_KEY="$line"
    break
  fi
done

if [ -z "$MASTER_KEY" ]; then
  echo "    WARN: Could not extract LITELLM_MASTER_KEY. Skipping key cleanup."
else
  KEYS_JSON=$(curl -sf -H "Authorization: Bearer $MASTER_KEY" "$LITELLM_URL/key/list" || echo "")
  if [ -z "$KEYS_JSON" ]; then
    echo "    WARN: Could not list keys from LiteLLM. Skipping."
  else
    KEYS=$(echo "$KEYS_JSON" | jq -c '.keys // []')
    KEY_COUNT=$(echo "$KEYS" | jq 'length')
    if [ "$KEY_COUNT" -eq 0 ]; then
      echo "    No virtual keys found."
    else
      echo "    Found $KEY_COUNT key(s). Deleting..."
      DEL_RESP=$(curl -sf -X POST -H "Authorization: Bearer $MASTER_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"keys\": $KEYS}" \
        "$LITELLM_URL/key/delete" || echo "")
      if [ -n "$DEL_RESP" ]; then
        DELETED=$(echo "$DEL_RESP" | jq '.deleted_keys | length // 0')
        echo "    Deleted $DELETED key(s)."
      else
        echo "    WARN: key deletion request failed."
      fi
    fi
  fi
fi

# ── Step 3: Truncate DB tables ───────────────────────────────────────

echo ""
echo "==> Step 3: Truncating DB tables..."
DB_APP="${PREFIX}-db"
DB_NAME="${PREFIX}_control"

DB_OUTPUT=$(printf '%s\n' "TRUNCATE TABLE pool_machines, api_keys, machines, users CASCADE;" "SELECT count(*) AS remaining_users FROM users;" '\q' \
  | fly postgres connect -a "$DB_APP" -d "$DB_NAME" 2>&1 || true)

if echo "$DB_OUTPUT" | grep -q "TRUNCATE TABLE"; then
  echo "    Tables truncated successfully."
else
  echo "    WARN: DB truncation may have failed. Output: $DB_OUTPUT"
fi

# ── Step 4: Build and push new image ─────────────────────────────────

echo ""
echo "==> Step 4: Building and pushing DeepClaw image..."
fly deploy "$REPO_ROOT" -a "$INSTANCE_APP" --config "$FLY_CONFIG"

echo "==> Capturing image reference from deployed machines..."
IMAGE=$(fly machines list -a "$INSTANCE_APP" --json | jq -r '.[0] | "\(.image_ref.registry)/\(.image_ref.repository):\(.image_ref.tag)"')
if [ -z "$IMAGE" ] || [ "$IMAGE" = "null" ]; then
  echo "ERROR: Could not extract image reference from machines" >&2
  exit 1
fi
echo "    Image: $IMAGE"

echo "==> Destroying default machines created by fly deploy..."
MACHINE_IDS=$(fly machines list -a "$INSTANCE_APP" --json | jq -r '.[].id')
for id in $MACHINE_IDS; do
  echo "    Destroying machine $id..."
  fly machines destroy "$id" -a "$INSTANCE_APP" --force
done

# ── Step 5: Update control plane ─────────────────────────────────────

echo ""
echo "==> Step 5: Updating control plane secret..."
fly secrets set OPENCLAW_IMAGE="$IMAGE" -a "$CONTROL_APP"
echo "==> Done. OPENCLAW_IMAGE set to $IMAGE"
