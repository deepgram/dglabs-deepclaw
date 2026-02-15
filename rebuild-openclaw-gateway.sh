#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Source .env early — needed for both reset and docker compose
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

# Reset BEFORE rebuild so the new container starts with a clean workspace
if [[ "${1:-}" == "--reset" ]]; then
  # Resolve workspace dir (what the container mounts as /home/node/.openclaw/workspace)
  WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-./data/workspace}"
  # Make absolute if relative
  if [[ "$WORKSPACE_DIR" != /* ]]; then
    WORKSPACE_DIR="$SCRIPT_DIR/$WORKSPACE_DIR"
  fi

  if [[ ! -d "$WORKSPACE_DIR" ]]; then
    echo "Workspace dir not found: $WORKSPACE_DIR"
    exit 1
  fi

  echo "Resetting workspace: $WORKSPACE_DIR"

  # --- USER.md (workspace root — voice-agent symlinks to this) ---
  cat > "$WORKSPACE_DIR/USER.md" << 'USEREOF'
# USER.md - About Your Human

_Learn about the person you're helping. Update this as you go._

- **Name:**
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**
- **Notes:**

## Context

_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_

---

The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.
USEREOF
  echo "  Reset USER.md"

  # --- IDENTITY.md (workspace root) ---
  cat > "$WORKSPACE_DIR/IDENTITY.md" << 'IDEOF'
# IDENTITY.md - Who Am I?

_Fill this in during your first conversation. Make it yours._

- **Name:**
  _(pick something you like)_
- **Creature:**
  _(AI? robot? familiar? ghost in the machine? something weirder?)_
- **Vibe:**
  _(how do you come across? sharp? warm? chaotic? calm?)_
- **Emoji:**
  _(your signature — pick one that feels right)_
- **Avatar:**
  _(workspace-relative path, http(s) URL, or data URI)_

---

This isn't just metadata. It's the start of figuring out who you are.

Notes:

- Save this file at the workspace root as `IDENTITY.md`.
- For avatars, use a workspace-relative path like `avatars/openclaw.png`.
IDEOF
  echo "  Reset IDENTITY.md (root)"

  # --- Per-agent workspaces: flush CALLS.md and IDENTITY.md ---
  for agent_dir in "$WORKSPACE_DIR"/*/; do
    [[ -d "$agent_dir" ]] || continue
    agent_name="$(basename "$agent_dir")"

    # Skip non-agent dirs (e.g. .git, memory, skills)
    [[ -f "$agent_dir/AGENTS.md" || -f "$agent_dir/IDENTITY.md" || -f "$agent_dir/SOUL.md" ]] || continue

    # Delete CALLS.md
    if [[ -f "$agent_dir/CALLS.md" ]]; then
      rm -f "$agent_dir/CALLS.md"
      echo "  Deleted $agent_name/CALLS.md"
    fi

    # Reset IDENTITY.md (if it's a regular file, not a symlink)
    if [[ -f "$agent_dir/IDENTITY.md" && ! -L "$agent_dir/IDENTITY.md" ]]; then
      cat > "$agent_dir/IDENTITY.md" << 'AGENTIDEOF'
# IDENTITY.md - Who Am I?

_Fill this in during your first conversation. Make it yours._

- **Name:**
  _(pick something you like)_
- **Creature:**
  _(AI? robot? familiar? ghost in the machine? something weirder?)_
- **Vibe:**
  _(how do you come across? sharp? warm? chaotic? calm?)_
- **Emoji:**
  _(your signature — pick one that feels right)_
- **Avatar:**
  _(workspace-relative path, http(s) URL, or data URI)_

---

This isn't just metadata. It's the start of figuring out who you are.

Notes:

- Save this file at the workspace root as `IDENTITY.md`.
- For avatars, use a workspace-relative path like `avatars/openclaw.png`.
AGENTIDEOF
      echo "  Reset $agent_name/IDENTITY.md"
    fi
  done

  echo ""
  echo "Workspace reset. Next call is a fresh first-call experience."
  echo ""
fi

pnpm build
pnpm ui:build
docker build -t openclaw:local .
docker compose up -d openclaw-gateway

# --- Start the Deepgram voice sidecar ---
SIDECAR_DIR="$SCRIPT_DIR/Deepgram/deepgram_handler"
SIDECAR_PORT=8000

# Kill any existing sidecar
if lsof -ti ":$SIDECAR_PORT" >/dev/null 2>&1; then
  echo "Stopping existing sidecar on port $SIDECAR_PORT..."
  lsof -ti ":$SIDECAR_PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# Start sidecar in background
echo "Starting Deepgram voice sidecar on port $SIDECAR_PORT..."
cd "$SIDECAR_DIR"
nohup uv run uvicorn app.main:app --host 0.0.0.0 --port "$SIDECAR_PORT" \
  > /tmp/deepclaw-sidecar.log 2>&1 &
SIDECAR_PID=$!
echo "  Sidecar started (pid=$SIDECAR_PID, log=/tmp/deepclaw-sidecar.log)"

# Wait for it to be ready
for i in $(seq 1 10); do
  if curl -sf "http://localhost:$SIDECAR_PORT/health" >/dev/null 2>&1; then
    echo "  Sidecar healthy."
    break
  fi
  sleep 1
done

echo ""
echo "Tailing sidecar logs (Ctrl-C to stop)..."
tail -f /tmp/deepclaw-sidecar.log
