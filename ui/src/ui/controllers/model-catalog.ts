import type { ModelCatalogEntry } from "../types.js";

type ModelCatalogState = {
  agentModelCatalog: ModelCatalogEntry[];
  agentModelCatalogLoading: boolean;
  client: { request: (method: string, params: Record<string, unknown>) => Promise<unknown> } | null;
  connected: boolean;
};

export async function loadModelCatalog(
  state: ModelCatalogState,
  opts?: { refresh?: boolean },
): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  state.agentModelCatalogLoading = true;
  try {
    const result = (await state.client.request("models.list", {
      refresh: opts?.refresh ?? false,
    })) as { models: ModelCatalogEntry[] };
    state.agentModelCatalog = result.models;
  } catch (err) {
    console.warn("[model-catalog] Failed to load model catalog:", err);
  } finally {
    state.agentModelCatalogLoading = false;
  }
}
