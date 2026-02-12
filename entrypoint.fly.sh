#!/bin/sh
set -e

# Default gateway token if not injected by control plane
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-openclaw-gateway-token}"
export OPENCLAW_GATEWAY_TOKEN

# --- Persistent volume seeding ---
# The Fly volume is mounted directly at /home/node/.openclaw, which shadows
# the image contents at that path. On first boot the volume is empty, so we
# seed it from the template copy baked into the image at /app/openclaw-templates.
#
# Seeding rules:
#   - openclaw.json: ALWAYS overwritten to match the current deployment.
#   - Workspace files: only copied if they don't already exist, so agent-
#     modified files (USER.md, MEMORY.md, sessions, etc.) survive deploys.
TEMPLATE_DIR="/app/openclaw-templates"
TARGET_DIR="/home/node/.openclaw"

if [ -d "$TEMPLATE_DIR" ]; then
  mkdir -p "$TARGET_DIR"

  # Always update config to match the deployed code
  if [ -f "$TEMPLATE_DIR/openclaw.json" ]; then
    cp "$TEMPLATE_DIR/openclaw.json" "$TARGET_DIR/openclaw.json"
  fi

  # Seed workspace template files only if they don't already exist
  # (preserves agent-modified files like USER.md, MEMORY.md across deploys)
  if [ -d "$TEMPLATE_DIR/workspace" ]; then
    mkdir -p "$TARGET_DIR/workspace"
    for f in "$TEMPLATE_DIR/workspace"/*; do
      basename="$(basename "$f")"
      if [ -d "$f" ]; then
        # Recursively copy subdirectories (e.g. voice-agent/) only if missing
        if [ ! -d "$TARGET_DIR/workspace/$basename" ]; then
          cp -r "$f" "$TARGET_DIR/workspace/$basename"
        else
          # Seed individual files inside existing subdirectories
          for sub in "$f"/*; do
            subname="$(basename "$sub")"
            if [ ! -e "$TARGET_DIR/workspace/$basename/$subname" ]; then
              cp "$sub" "$TARGET_DIR/workspace/$basename/$subname"
            fi
          done
        fi
      elif [ ! -e "$TARGET_DIR/workspace/$basename" ]; then
        cp "$f" "$TARGET_DIR/workspace/$basename"
      fi
    done
  fi

  # Seed any other top-level directories (agents/, credentials/, etc.)
  for d in "$TEMPLATE_DIR"/*/; do
    dirname="$(basename "$d")"
    [ "$dirname" = "workspace" ] && continue
    if [ ! -d "$TARGET_DIR/$dirname" ]; then
      cp -r "$d" "$TARGET_DIR/$dirname"
    fi
  done
fi

exec "$@"
