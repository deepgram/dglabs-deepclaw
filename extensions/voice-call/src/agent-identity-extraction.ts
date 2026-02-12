/**
 * Post-call agent identity extraction — runs the embedded Pi agent to extract
 * the agent's self-chosen identity (name, personality, etc.) from a completed
 * call transcript and writes it to IDENTITY.md. Mirrors the pattern from
 * user-profile-extraction.ts but focuses on the agent's self-introduction.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { VoiceCallConfig } from "./config.js";
import type { CallRecord } from "./types.js";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";

// Re-use core identity types — imported dynamically to avoid circular deps
// with the core package. We inline the minimal interface here.
type AgentIdentityFile = {
  name?: string;
  emoji?: string;
  creature?: string;
  vibe?: string;
  avatar?: string;
};

// Names that indicate the model didn't actually pick something personal.
const GENERIC_NAMES = new Set([
  "voice agent",
  "assistant",
  "ai",
  "ai assistant",
  "bot",
  "agent",
  "helper",
]);

// ---------------------------------------------------------------------------
// Helpers (mirror identity-file.ts logic without importing core at module level)
// ---------------------------------------------------------------------------

const IDENTITY_PLACEHOLDER_VALUES = new Set([
  "pick something you like",
  "ai? robot? familiar? ghost in the machine? something weirder?",
  "how do you come across? sharp? warm? chaotic? calm?",
  "your signature - pick one that feels right",
  "workspace-relative path, http(s) url, or data uri",
]);

function normalizeIdentityValue(value: string): string {
  let normalized = value.trim();
  normalized = normalized.replace(/^[*_]+|[*_]+$/g, "").trim();
  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  normalized = normalized.replace(/[\u2013\u2014]/g, "-");
  normalized = normalized.replace(/\s+/g, " ").toLowerCase();
  return normalized;
}

function isIdentityPlaceholder(value: string): boolean {
  return IDENTITY_PLACEHOLDER_VALUES.has(normalizeIdentityValue(value));
}

function parseIdentityMarkdown(content: string): AgentIdentityFile {
  const identity: AgentIdentityFile = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.trim().replace(/^\s*-\s*/, "");
    const colonIndex = cleaned.indexOf(":");
    if (colonIndex === -1) continue;
    const label = cleaned.slice(0, colonIndex).replace(/[*_]/g, "").trim().toLowerCase();
    const value = cleaned
      .slice(colonIndex + 1)
      .replace(/^[*_]+|[*_]+$/g, "")
      .trim();
    if (!value || isIdentityPlaceholder(value)) continue;
    if (label === "name") identity.name = value;
    if (label === "emoji") identity.emoji = value;
    if (label === "creature") identity.creature = value;
    if (label === "vibe") identity.vibe = value;
    if (label === "avatar") identity.avatar = value;
  }
  return identity;
}

function identityHasValues(identity: AgentIdentityFile): boolean {
  return Boolean(
    identity.name || identity.emoji || identity.creature || identity.vibe || identity.avatar,
  );
}

function serializeIdentityMarkdown(identity: AgentIdentityFile): string {
  const lines = [`# IDENTITY.md - Who Am I?`, ``];
  lines.push(`- **Name:** ${identity.name ?? ""}`);
  lines.push(`- **Creature:** ${identity.creature ?? ""}`);
  lines.push(`- **Vibe:** ${identity.vibe ?? ""}`);
  lines.push(`- **Emoji:** ${identity.emoji ?? ""}`);
  lines.push(`- **Avatar:** ${identity.avatar ?? ""}`);
  lines.push(``);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export type AgentIdentityExtractionParams = {
  voiceConfig: VoiceCallConfig;
  coreConfig: CoreConfig;
  callRecord: CallRecord;
  agentId: string;
};

/**
 * Extract agent identity data from a completed call transcript and write to
 * IDENTITY.md. Fire-and-forget — errors are logged but never thrown.
 */
export async function extractAgentIdentityFromCall(
  params: AgentIdentityExtractionParams,
): Promise<void> {
  const { voiceConfig, coreConfig, callRecord, agentId } = params;

  console.log(
    `[voice-call] Agent identity extraction: transcript has ${callRecord.transcript.length} entries (bot=${callRecord.transcript.filter((e) => e.speaker === "bot").length}, user=${callRecord.transcript.filter((e) => e.speaker === "user").length})`,
  );
  if (callRecord.transcript.length === 0) {
    console.log(`[voice-call] Skipping agent identity extraction: no transcript entries`);
    return;
  }

  let deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>;
  try {
    deps = await loadCoreAgentDeps();
  } catch (err) {
    console.error(`[voice-call] Agent identity extraction failed (deps):`, err);
    return;
  }

  const workspaceDir = deps.resolveAgentWorkspaceDir(coreConfig, agentId);
  await deps.ensureAgentWorkspace({ dir: workspaceDir });

  // Read existing IDENTITY.md
  const identityFilePath = path.join(workspaceDir, "IDENTITY.md");
  let existingContent = "";
  try {
    existingContent = await fsp.readFile(identityFilePath, "utf-8");
  } catch {
    // File doesn't exist yet — will create from scratch
  }

  const existingIdentity = existingContent ? parseIdentityMarkdown(existingContent) : {};

  // Skip if identity already has values (any field populated means we're done)
  if (identityHasValues(existingIdentity)) {
    console.log(`[voice-call] Skipping agent identity extraction: identity already populated`);
    return;
  }

  // Format transcript
  const transcriptText = callRecord.transcript
    .map((entry) => `${entry.speaker === "bot" ? "Agent" : "Caller"}: ${entry.text}`)
    .join("\n");

  console.log(`[voice-call] Agent identity extraction transcript:\n${transcriptText}`);

  const prompt = [
    `Extract the AI agent's self-chosen identity from this phone call transcript.`,
    `Focus on how the AGENT introduced or described itself — not the caller.\n`,
    `Return ONLY a JSON object with fields you can confidently extract from the conversation.\n`,
    `Fields:`,
    `- "name": The name the agent used to introduce itself (e.g. "I'm Ripley")`,
    `- "creature": How the agent described what it is (e.g. "AI assistant", "voice companion")`,
    `- "vibe": The agent's personality/tone (e.g. "casual and warm", "direct and helpful")`,
    `- "emoji": Any emoji the agent associated with itself\n`,
    `The "name" field is the most important:`,
    `- If the agent introduced itself by name or the caller gave it a name, use that.`,
    `- If no name was established, PICK a distinctive, personal name — something like "Wren", "Ember", "Moss", "Sable". Not generic like "Assistant" or "AI".`,
    `For other fields, only include them if supported by clear evidence in the transcript.`,
    `Return valid JSON only, no markdown.\n`,
    `Transcript:\n${transcriptText}`,
  ].join("\n");

  // Resolve model — use same responseModel as user profile extraction
  const modelRef = voiceConfig.responseModel || `${deps.DEFAULT_PROVIDER}/${deps.DEFAULT_MODEL}`;
  const slashIndex = modelRef.indexOf("/");
  const provider = slashIndex === -1 ? deps.DEFAULT_PROVIDER : modelRef.slice(0, slashIndex);
  const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);

  const sessionId = crypto.randomUUID();
  const agentDir = deps.resolveAgentDir(coreConfig, agentId);
  const storePath = deps.resolveStorePath(coreConfig.session?.store, { agentId });
  const sessionStore = deps.loadSessionStore(storePath);
  const sessionEntry = { sessionId, updatedAt: Date.now() };
  const sessionFile = deps.resolveSessionFilePath(sessionId, sessionEntry, { agentId });

  try {
    const result = await deps.runEmbeddedPiAgent({
      sessionId,
      sessionKey: `agent:${agentId}:agent-identity:${callRecord.callId}`,
      messageProvider: "voice",
      sessionFile,
      workspaceDir,
      config: coreConfig,
      prompt,
      provider,
      model,
      thinkLevel: "none",
      verboseLevel: "off",
      timeoutMs: 30000,
      runId: `agent-identity:${callRecord.callId}`,
      lane: "voice",
      extraSystemPrompt:
        "Extract the AI agent's identity from this call transcript. Return valid JSON only.",
      agentDir,
    });

    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const rawResponse = texts.join(" ");
    console.log(
      `[voice-call] Agent identity extraction raw response: ${rawResponse.slice(0, 500)}`,
    );
    if (!rawResponse) {
      console.warn(`[voice-call] Agent identity extraction: agent returned no text`);
      return;
    }

    // Parse JSON response — handle code fences and malformed output
    let jsonStr = rawResponse;
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1]!;
    }
    jsonStr = jsonStr.trim();

    let extracted: Record<string, unknown>;
    try {
      extracted = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      console.warn(
        `[voice-call] Agent identity extraction: failed to parse JSON: ${jsonStr.slice(0, 200)}`,
      );
      return;
    }

    console.log(`[voice-call] Agent identity extraction parsed JSON: ${JSON.stringify(extracted)}`);

    // Build extracted identity from JSON
    const extractedIdentity: AgentIdentityFile = {};
    if (typeof extracted.name === "string" && extracted.name.trim()) {
      extractedIdentity.name = extracted.name.trim();
    }
    if (typeof extracted.creature === "string" && extracted.creature.trim()) {
      extractedIdentity.creature = extracted.creature.trim();
    }
    if (typeof extracted.vibe === "string" && extracted.vibe.trim()) {
      extractedIdentity.vibe = extracted.vibe.trim();
    }
    if (typeof extracted.emoji === "string" && extracted.emoji.trim()) {
      extractedIdentity.emoji = extracted.emoji.trim();
    }

    // Strip generic names — the LLM should have picked something distinctive,
    // but clear it out if it still returned something generic.
    if (extractedIdentity.name && GENERIC_NAMES.has(extractedIdentity.name.toLowerCase())) {
      console.log(
        `[voice-call] Agent identity extraction: name "${extractedIdentity.name}" is generic, discarding`,
      );
      delete extractedIdentity.name;
    }

    if (!identityHasValues(extractedIdentity)) {
      console.log(
        `[voice-call] Agent identity extraction: no values extracted from transcript (extractedIdentity=${JSON.stringify(extractedIdentity)})`,
      );
      return;
    }

    // Merge — only fill empty fields
    const merged: AgentIdentityFile = { ...existingIdentity };
    if (!merged.name && extractedIdentity.name) merged.name = extractedIdentity.name;
    if (!merged.creature && extractedIdentity.creature)
      merged.creature = extractedIdentity.creature;
    if (!merged.vibe && extractedIdentity.vibe) merged.vibe = extractedIdentity.vibe;
    if (!merged.emoji && extractedIdentity.emoji) merged.emoji = extractedIdentity.emoji;

    const serialized = serializeIdentityMarkdown(merged);
    await fsp.writeFile(identityFilePath, serialized, "utf-8");

    // Clean up ephemeral session file (best-effort)
    try {
      if (fs.existsSync(sessionFile)) {
        await fsp.unlink(sessionFile);
      }
    } catch {
      // ignore
    }

    // Clean up session store entry (best-effort)
    const sessionKey = `agent:${agentId}:agent-identity:${callRecord.callId}`;
    if (sessionStore[sessionKey]) {
      delete sessionStore[sessionKey];
      await deps.saveSessionStore(storePath, sessionStore).catch(() => {});
    }

    console.log(`[voice-call] Agent identity extracted for ${callRecord.callId}`);
  } catch (err) {
    console.error(`[voice-call] Agent identity extraction failed:`, err);
  }
}
