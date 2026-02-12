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
      `You're a voice assistant on a phone call. You're about to run a tool called "${context.toolName}"${argsSnippet} and need to say something brief while it executes. ` +
      `Generate a single short phrase (under 10 words) that references what you're specifically doing — not a generic acknowledgment. ` +
      `BAD: "Sure thing." "Got it." "Working on that." ` +
      `GOOD: "Let me pull that up." "Checking the calendar now." "Looking into that for you." ` +
      `Output ONLY the phrase. End with a period.`
    );
  }
  return (
    `You're a voice assistant on a phone call. The user just said: "${context.userMessage}". ` +
    `You need a moment to think. Generate a single short "thinking" phrase (under 10 words) that shows you're considering their specific question — not a generic acknowledgment. ` +
    `BAD: "Got it." "Sure thing." "Absolutely." (these sound like the real answer starting) ` +
    `GOOD: "Hmm, good question." "Let me think about that." "Oh interesting, one sec." ` +
    `Output ONLY the phrase. End with a period.`
  );
}

function buildFillerSetPrompt(context: FillerContext): string {
  if ("toolName" in context) {
    const argsSnippet = context.args ? ` with ${JSON.stringify(context.args)}` : "";
    return (
      `You're a voice assistant on a phone call. You're running a tool called "${context.toolName}"${argsSnippet} and it's taking a while. ` +
      `Generate 4 brief phrases (each under 10 words) to say while waiting. They'll be spoken in sequence if the wait is long. ` +
      `Make them specific to the action — reference what you're looking up/doing, not generic filler. ` +
      `AVOID: "Got it" "Sure thing" "Of course" "Absolutely" — these sound like the real response starting. ` +
      `Phrase 1: what you're doing ("Let me pull that up.") ` +
      `Phrase 2: still working ("Still searching..." / "Almost got it.") ` +
      `Phrase 3: taking longer ("Taking a bit longer than usual.") ` +
      `Phrase 4: almost done ("Okay, here we go.") ` +
      `Output one phrase per line. Nothing else.`
    );
  }
  return (
    `You're a voice assistant on a phone call. The user said: "${context.userMessage}". ` +
    `You need time to think. Generate 4 brief "thinking aloud" phrases (each under 10 words) to say while formulating your response. ` +
    `Make them feel like you're actually mulling over their specific topic — not generic acknowledgments. ` +
    `AVOID: "Got it" "Sure thing" "Of course" "Absolutely" — these sound like the real response starting. ` +
    `Phrase 1: acknowledge you're thinking ("Hmm, let me think about that.") ` +
    `Phrase 2: still thinking ("That's a good one, give me a sec.") ` +
    `Phrase 3: working through it ("Okay, I think I've got something.") ` +
    `Phrase 4: ready ("Alright, here's what I'm thinking.") ` +
    `Output one phrase per line. Nothing else.`
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
