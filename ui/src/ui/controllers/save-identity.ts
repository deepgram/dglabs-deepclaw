import type { AgentFilesState } from "./agent-files.ts";
import type { AgentIdentityState } from "./agent-identity.ts";
import { loadAgentIdentity } from "./agent-identity.ts";

export type SaveIdentityState = AgentFilesState &
  AgentIdentityState & {
    identityDraftName: string | null;
    identityDraftEmoji: string | null;
    identitySaving: boolean;
  };

/**
 * Replace (or append) a `- Field: value` line in IDENTITY.md content.
 * Handles markdown bold/italic wrapping on the field name.
 */
export function replaceIdentityField(content: string, field: string, newValue: string): string {
  const pattern = new RegExp(
    `^(\\s*-\\s+(?:\\*{1,2}|_{1,2})?)${escapeRegExp(field)}((?:\\*{1,2}|_{1,2})?\\s*:\\s*).*$`,
    "im",
  );
  const match = content.match(pattern);
  if (match) {
    return content.replace(pattern, `$1${field}$2${newValue}`);
  }
  // Append the field if not found
  const trimmed = content.trimEnd();
  const separator = trimmed ? "\n" : "";
  return `${trimmed}${separator}- ${field}: ${newValue}\n`;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function saveAgentIdentity(state: SaveIdentityState, agentId: string) {
  if (!state.client || !state.connected || state.identitySaving) {
    return;
  }

  const draftName = state.identityDraftName;
  const draftEmoji = state.identityDraftEmoji;
  if (draftName == null && draftEmoji == null) {
    return;
  }

  state.identitySaving = true;
  try {
    // Read current IDENTITY.md
    let content = "";
    try {
      const res = await state.client.request<{ file?: { content?: string; missing?: boolean } }>(
        "agents.files.get",
        { agentId, name: "IDENTITY.md" },
      );
      content = res?.file?.content ?? "";
    } catch {
      // File may not exist yet
    }

    // Apply field replacements
    if (draftName != null) {
      content = replaceIdentityField(content, "Name", draftName);
    }
    if (draftEmoji != null) {
      content = replaceIdentityField(content, "Emoji", draftEmoji);
    }

    // Write back
    await state.client.request("agents.files.set", {
      agentId,
      name: "IDENTITY.md",
      content,
    });

    // Clear drafts
    state.identityDraftName = null;
    state.identityDraftEmoji = null;

    // Invalidate identity cache so it reloads
    const { [agentId]: _, ...rest } = state.agentIdentityById;
    state.agentIdentityById = rest;
    void loadAgentIdentity(state, agentId);

    // Sync the files tab if IDENTITY.md was previously loaded
    if (Object.hasOwn(state.agentFileContents, "IDENTITY.md")) {
      state.agentFileContents = { ...state.agentFileContents, "IDENTITY.md": content };
      state.agentFileDrafts = { ...state.agentFileDrafts, "IDENTITY.md": content };
    }
  } catch (err) {
    state.agentIdentityError = String(err);
  } finally {
    state.identitySaving = false;
  }
}
