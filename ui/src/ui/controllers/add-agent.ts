import type { GatewayBrowserClient } from "../gateway.ts";
import type { AddAgentFormState } from "../ui-types.ts";

export type AddAgentState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  addAgentBusy: boolean;
  addAgentError: string | null;
  addAgentForm: AddAgentFormState;
  addAgentModalOpen: boolean;
  agentsSelectedId: string | null;
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function submitAddAgent(state: AddAgentState): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  if (state.addAgentBusy) {
    return null;
  }

  const form = state.addAgentForm;
  const name = form.name.trim();
  if (!name) {
    state.addAgentError = "Agent name is required.";
    return null;
  }

  state.addAgentBusy = true;
  state.addAgentError = null;

  try {
    const workspace = form.workspace.trim() || `~/.openclaw/workspace/${slugify(name)}`;
    const params: Record<string, unknown> = { name, workspace };
    if (form.emoji.trim()) {
      params.emoji = form.emoji.trim();
    }
    if (form.agentType === "voice") {
      params.agentType = "voice";
    }

    const res = await state.client.request<{ agentId: string }>("agents.create", params);
    if (!res?.agentId) {
      state.addAgentError = "Failed to create agent — no ID returned.";
      return null;
    }
    const agentId = res.agentId;

    if (form.agentType === "voice") {
      let existing = "";
      try {
        const fileRes = await state.client.request<{ content: string }>("agents.files.get", {
          agentId,
          name: "IDENTITY.md",
        });
        existing = fileRes?.content ?? "";
      } catch {
        // File may not exist yet
      }

      const lines: string[] = [];
      if (form.voice.trim()) {
        lines.push(`Voice: ${form.voice.trim()}`);
      }
      if (form.greeting.trim()) {
        lines.push(`Greeting: ${form.greeting.trim()}`);
      }

      if (lines.length > 0) {
        const separator = existing.trim() ? "\n\n" : "";
        const updated = existing.trim() + separator + lines.join("\n") + "\n";
        await state.client.request("agents.files.set", {
          agentId,
          name: "IDENTITY.md",
          content: updated,
        });
      }
    }

    state.agentsSelectedId = agentId;
    state.addAgentModalOpen = false;
    return agentId;
  } catch (err) {
    state.addAgentError = String(err);
    return null;
  } finally {
    state.addAgentBusy = false;
  }
}
