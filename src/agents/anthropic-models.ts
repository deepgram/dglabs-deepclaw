import type { ModelDefinitionConfig } from "../config/types.js";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Resolve the Anthropic base URL, preferring the env override (e.g. LiteLLM proxy). */
export function resolveAnthropicBaseUrl(): string {
  return process.env.ANTHROPIC_BASE_URL?.trim() || ANTHROPIC_DEFAULT_BASE_URL;
}

// Anthropic uses per-token pricing that varies by model.
// Set to 0 as costs vary by model; override in models.json for accurate costs.
export const ANTHROPIC_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Static catalog of common Anthropic chat models.
 * Serves as a fallback when the Anthropic API is unreachable.
 */
export const ANTHROPIC_MODEL_CATALOG = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 200000,
    maxTokens: 16384,
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 200000,
    maxTokens: 8192,
  },
] as const;

export type AnthropicCatalogEntry = (typeof ANTHROPIC_MODEL_CATALOG)[number];

export function buildAnthropicModelDefinition(entry: AnthropicCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: ANTHROPIC_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

// Prefixes for non-chat models to filter out from discovery
const NON_CHAT_PREFIXES = ["claude-1", "claude-instant"];

// Anthropic API response types
interface AnthropicModel {
  id: string;
  type: string;
  display_name?: string;
}

interface AnthropicModelsResponse {
  data: AnthropicModel[];
}

/**
 * Discover models from Anthropic API with fallback to static catalog.
 * Requires an API key for authentication.
 */
export async function discoverAnthropicModels(params: {
  apiKey: string;
}): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return ANTHROPIC_MODEL_CATALOG.map(buildAnthropicModelDefinition);
  }

  try {
    const baseUrl = resolveAnthropicBaseUrl();
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        "x-api-key": params.apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(
        `[anthropic-models] Failed to discover models: HTTP ${response.status}, using static catalog`,
      );
      return ANTHROPIC_MODEL_CATALOG.map(buildAnthropicModelDefinition);
    }

    const data = (await response.json()) as AnthropicModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      console.warn("[anthropic-models] No models found from API, using static catalog");
      return ANTHROPIC_MODEL_CATALOG.map(buildAnthropicModelDefinition);
    }

    // Filter out legacy non-chat models
    const chatModels = data.data.filter(
      (m) => !NON_CHAT_PREFIXES.some((prefix) => m.id.startsWith(prefix)),
    );

    // Merge discovered models with catalog metadata
    const catalogById = new Map<string, AnthropicCatalogEntry>(
      ANTHROPIC_MODEL_CATALOG.map((m) => [m.id, m]),
    );
    const models: ModelDefinitionConfig[] = [];

    for (const apiModel of chatModels) {
      const catalogEntry = catalogById.get(apiModel.id);
      if (catalogEntry) {
        // Use catalog metadata for known models
        models.push(buildAnthropicModelDefinition(catalogEntry));
      } else {
        // Create definition for newly discovered models not in catalog
        models.push({
          id: apiModel.id,
          name: apiModel.display_name ?? apiModel.id,
          reasoning: false,
          input: ["text", "image"],
          cost: ANTHROPIC_DEFAULT_COST,
          contextWindow: 200000,
          maxTokens: 8192,
        });
      }
    }

    return models.length > 0 ? models : ANTHROPIC_MODEL_CATALOG.map(buildAnthropicModelDefinition);
  } catch (error) {
    console.warn(`[anthropic-models] Discovery failed: ${String(error)}, using static catalog`);
    return ANTHROPIC_MODEL_CATALOG.map(buildAnthropicModelDefinition);
  }
}
