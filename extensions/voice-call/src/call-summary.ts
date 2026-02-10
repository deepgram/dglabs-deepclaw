/**
 * Post-call summary generator — runs the embedded Pi agent to summarize a
 * completed call transcript and appends the result to CALLS.md in the agent's
 * workspace so future interactions have context about past calls.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { VoiceCallConfig } from "./config.js";
import type { CallRecord } from "./types.js";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";

export type CallSummaryParams = {
  voiceConfig: VoiceCallConfig;
  coreConfig: CoreConfig;
  callRecord: CallRecord;
  agentId: string;
};

/**
 * Generate a post-call summary and append it to CALLS.md in the agent's workspace.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function generateCallSummary(params: CallSummaryParams): Promise<void> {
  const { voiceConfig, coreConfig, callRecord, agentId } = params;

  if (!voiceConfig.callSummary.enabled) {
    return;
  }

  if (callRecord.transcript.length === 0) {
    console.log(`[voice-call] Skipping call summary: no transcript entries`);
    return;
  }

  let deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>;
  try {
    deps = await loadCoreAgentDeps();
  } catch (err) {
    console.error(`[voice-call] Call summary failed (deps):`, err);
    return;
  }

  const workspaceDir = deps.resolveAgentWorkspaceDir(coreConfig, agentId);
  await deps.ensureAgentWorkspace({ dir: workspaceDir });

  // Format transcript for the summarization prompt
  const transcriptText = callRecord.transcript
    .map((entry) => `${entry.speaker === "bot" ? "Agent" : "Caller"}: ${entry.text}`)
    .join("\n");

  const direction = callRecord.direction === "inbound" ? "inbound" : "outbound";
  const callerNumber = callRecord.direction === "inbound" ? callRecord.from : callRecord.to;

  const prompt = [
    `Summarize this phone call in 2-3 concise sentences.`,
    `Include: who called, what was discussed, any action items or outcomes.`,
    `Write plain text only — no markdown formatting, no bullet points.\n`,
    `Call direction: ${direction}`,
    `Phone number: ${callerNumber}\n`,
    `Transcript:\n${transcriptText}`,
  ].join("\n");

  // Resolve model — use same responseModel as voice responses (cheap/fast)
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
      sessionKey: `agent:${agentId}:call-summary:${callRecord.callId}`,
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
      runId: `call-summary:${callRecord.callId}`,
      lane: "voice",
      extraSystemPrompt:
        "Summarize this phone call in 2-3 concise sentences. Include: who called, what was discussed, any action items or outcomes. Write plain text only.",
      agentDir,
    });

    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const summary = texts.join(" ");
    if (!summary) {
      console.warn(`[voice-call] Call summary: agent returned no text`);
      return;
    }

    // Format timestamp in configured timezone
    const tz = voiceConfig.timezone ?? "UTC";
    const endedAt = callRecord.endedAt ?? Date.now();
    const timestamp = new Date(endedAt).toLocaleString("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    const entry = `### ${timestamp} — ${callerNumber} (${direction})\n${summary}\n`;

    // Append to CALLS.md
    const callsFilePath = path.join(workspaceDir, "CALLS.md");
    let existing = "";
    try {
      existing = await fsp.readFile(callsFilePath, "utf-8");
    } catch {
      // File doesn't exist yet — start fresh with a header
      existing = "# Call History\n\n";
    }

    const updated = existing.trimEnd() + "\n\n" + entry;

    // Trim to maxEntries
    const maxEntries = voiceConfig.callSummary.maxEntries;
    const trimmed = trimCallEntries(updated, maxEntries);

    await fsp.writeFile(callsFilePath, trimmed, "utf-8");

    // Clean up the ephemeral session file (best-effort)
    try {
      if (fs.existsSync(sessionFile)) {
        await fsp.unlink(sessionFile);
      }
    } catch {
      // ignore
    }

    // Clean up session store entry (best-effort)
    const sessionKey = `agent:${agentId}:call-summary:${callRecord.callId}`;
    if (sessionStore[sessionKey]) {
      delete sessionStore[sessionKey];
      await deps.saveSessionStore(storePath, sessionStore).catch(() => {});
    }

    console.log(`[voice-call] Call summary generated for ${callRecord.callId}`);
  } catch (err) {
    console.error(`[voice-call] Call summary generation failed:`, err);
  }
}

/**
 * Trim CALLS.md to keep only the header + last N entries.
 * Entries are delimited by ### headings.
 */
function trimCallEntries(content: string, maxEntries: number): string {
  const parts = content.split(/(?=^### )/m);

  // First part is the header (everything before the first ### entry)
  const header = parts[0] || "# Call History\n\n";
  const entries = parts.slice(1);

  if (entries.length <= maxEntries) {
    return content;
  }

  const kept = entries.slice(-maxEntries);
  return header.trimEnd() + "\n\n" + kept.join("").trimEnd() + "\n";
}
