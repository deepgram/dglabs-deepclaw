import type { ModelDefinitionConfig } from "../config/types.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

// OpenAI uses per-token pricing that varies by model.
// Set to 0 as costs vary by model; override in models.json for accurate costs.
export const OPENAI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Static catalog of common OpenAI chat models.
 * Serves as a fallback when the OpenAI API is unreachable.
 */
export const OPENAI_MODEL_CATALOG = [
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 1047576,
    maxTokens: 32768,
  },
  {
    id: "gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 1047576,
    maxTokens: 32768,
  },
  {
    id: "gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 1047576,
    maxTokens: 32768,
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128000,
    maxTokens: 16384,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128000,
    maxTokens: 16384,
  },
  {
    id: "o4-mini",
    name: "o4-mini",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 200000,
    maxTokens: 100000,
  },
  {
    id: "o3",
    name: "o3",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 200000,
    maxTokens: 100000,
  },
  {
    id: "o3-mini",
    name: "o3-mini",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 200000,
    maxTokens: 100000,
  },
  {
    id: "o1",
    name: "o1",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 200000,
    maxTokens: 100000,
  },
  {
    id: "o1-mini",
    name: "o1-mini",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 128000,
    maxTokens: 65536,
  },
  {
    id: "chatgpt-4o-latest",
    name: "ChatGPT-4o Latest",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128000,
    maxTokens: 16384,
  },
] as const;

export type OpenAiCatalogEntry = (typeof OPENAI_MODEL_CATALOG)[number];

export function buildOpenAiModelDefinition(entry: OpenAiCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: OPENAI_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

// Prefixes for non-chat models to filter out from discovery
const NON_CHAT_PREFIXES = ["dall-e", "whisper", "tts", "text-embedding", "babbage", "davinci"];

// OpenAI API response types
interface OpenAiModel {
  id: string;
  object: string;
  owned_by: string;
}

interface OpenAiModelsResponse {
  data: OpenAiModel[];
}

/**
 * Discover models from OpenAI API with fallback to static catalog.
 * Requires an API key for authentication.
 *
 * Note: `baseUrl` should be the root URL without `/v1` (e.g. `https://api.openai.com`),
 * since this function appends `/v1/models` itself. This differs from `OPENAI_BASE_URL`
 * which includes `/v1` for use as the completions base URL.
 */
export async function discoverOpenAiModels(params: {
  apiKey: string;
  baseUrl?: string;
}): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return OPENAI_MODEL_CATALOG.map(buildOpenAiModelDefinition);
  }

  const baseUrl = params.baseUrl ?? "https://api.openai.com";

  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(
        `[openai-models] Failed to discover models: HTTP ${response.status}, using static catalog`,
      );
      return OPENAI_MODEL_CATALOG.map(buildOpenAiModelDefinition);
    }

    const data = (await response.json()) as OpenAiModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      console.warn("[openai-models] No models found from API, using static catalog");
      return OPENAI_MODEL_CATALOG.map(buildOpenAiModelDefinition);
    }

    // Filter to chat-capable models only
    const chatModels = data.data.filter(
      (m) => !NON_CHAT_PREFIXES.some((prefix) => m.id.startsWith(prefix)),
    );

    // Merge discovered models with catalog metadata
    const catalogById = new Map<string, OpenAiCatalogEntry>(
      OPENAI_MODEL_CATALOG.map((m) => [m.id, m]),
    );
    const models: ModelDefinitionConfig[] = [];

    for (const apiModel of chatModels) {
      const catalogEntry = catalogById.get(apiModel.id);
      if (catalogEntry) {
        // Use catalog metadata for known models
        models.push(buildOpenAiModelDefinition(catalogEntry));
      } else {
        // Create definition for newly discovered models not in catalog
        const isReasoning = /^o\d/.test(apiModel.id);

        models.push({
          id: apiModel.id,
          name: apiModel.id,
          reasoning: isReasoning,
          input: ["text"],
          cost: OPENAI_DEFAULT_COST,
          contextWindow: 128000,
          maxTokens: 16384,
        });
      }
    }

    return models.length > 0 ? models : OPENAI_MODEL_CATALOG.map(buildOpenAiModelDefinition);
  } catch (error) {
    console.warn(`[openai-models] Discovery failed: ${String(error)}, using static catalog`);
    return OPENAI_MODEL_CATALOG.map(buildOpenAiModelDefinition);
  }
}
