/**
 * Dynamic filler phrase generation via Claude Haiku.
 *
 * When a voice call function call or LLM response takes too long, the system
 * injects a filler phrase. This module generates context-aware phrases using
 * Claude Haiku instead of picking randomly from a static list.
 */

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
const HARD_TIMEOUT_MS = 2000;

type FillerContext = { toolName: string; args?: Record<string, unknown> } | { userMessage: string };

function buildPrompt(context: FillerContext): string {
  if ("toolName" in context) {
    const argsSnippet = context.args ? ` with ${JSON.stringify(context.args)}` : "";
    return (
      `Generate a single brief, natural filler phrase (under 12 words) that a voice assistant would say while executing the "${context.toolName}" tool${argsSnippet}. ` +
      `The phrase should acknowledge what the user asked for. Output ONLY the phrase, nothing else. End with a period and a trailing space.`
    );
  }
  return (
    `Generate a single brief, natural filler phrase (under 12 words) that a voice assistant would say while thinking about a response to: "${context.userMessage}". ` +
    `The phrase should acknowledge the user's request. Output ONLY the phrase, nothing else. End with a period and a trailing space.`
  );
}

function buildFillerSetPrompt(context: FillerContext): string {
  const subject =
    "toolName" in context
      ? `executing the "${context.toolName}" tool`
      : `responding to: "${context.userMessage}"`;
  return (
    `Generate 4 brief, natural filler phrases (each under 12 words) that a voice assistant would say while ${subject}. ` +
    `The first phrase should acknowledge the request. The remaining phrases are follow-ups for if the wait continues (e.g. "Still working on that.", "Almost there."). ` +
    `Each phrase should be different and natural-sounding. Output one phrase per line, nothing else. End each with a period.`
  );
}

async function callHaiku(
  prompt: string,
  apiKey: string,
  maxTokens: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    return data.content?.[0]?.text?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call Claude Haiku to generate a context-aware filler phrase.
 *
 * Returns `null` on any failure (network error, missing key, timeout)
 * so callers can fall back to a static phrase.
 */
export async function generateFillerPhrase(
  context: FillerContext,
  apiKey: string,
): Promise<string | null> {
  if (!apiKey) return null;
  return callHaiku(buildPrompt(context), apiKey, 50);
}

/**
 * Generate a set of filler phrases (primary + follow-ups) in a single Haiku call.
 *
 * Returns an array of phrases, or `null` on failure.
 * The first phrase is the initial acknowledgment; the rest are follow-ups.
 */
export async function generateFillerSet(
  context: FillerContext,
  apiKey: string,
): Promise<string[] | null> {
  if (!apiKey) return null;
  const text = await callHaiku(buildFillerSetPrompt(context), apiKey, 150);
  if (!text) return null;
  const phrases = text
    .split("\n")
    .map((line) => line.replace(/^\d+[\.\)]\s*/, "").trim())
    .filter((line) => line.length > 0 && line.length < 80);
  return phrases.length > 0 ? phrases : null;
}
