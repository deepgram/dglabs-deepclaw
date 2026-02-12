/**
 * Post-call user profile extraction — runs the embedded Pi agent to extract
 * user profile data from a completed call transcript and merges it into
 * USER.md in the agent's workspace. Enables voice-first onboarding: the user
 * tells you their name while asking about chicken recipes, not in response to
 * "What should I call you?"
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { VoiceCallConfig } from "./config.js";
import type { CallRecord } from "./types.js";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";
import {
  type UserProfile,
  parseUserMarkdown,
  userProfileHasValues,
  mergeUserProfiles,
  serializeUserMarkdown,
} from "./user-md-parser.js";

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export type UserProfileExtractionParams = {
  voiceConfig: VoiceCallConfig;
  coreConfig: CoreConfig;
  callRecord: CallRecord;
  agentId: string;
};

/**
 * Extract user profile data from a completed call transcript and merge into
 * USER.md. Fire-and-forget — errors are logged but never thrown.
 */
export async function extractUserProfileFromCall(
  params: UserProfileExtractionParams,
): Promise<void> {
  const { voiceConfig, coreConfig, callRecord, agentId } = params;

  console.log(
    `[USER.md lifecycle] extractUserProfileFromCall called — agentId=${agentId} callId=${callRecord.callId}`,
  );

  if (!voiceConfig.userProfile.enabled) {
    console.log(`[USER.md lifecycle] SKIP: userProfile.enabled=false in voiceConfig`);
    return;
  }

  if (callRecord.transcript.length === 0) {
    console.log(`[USER.md lifecycle] SKIP: no transcript entries`);
    return;
  }

  let deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>;
  try {
    deps = await loadCoreAgentDeps();
  } catch (err) {
    console.error(`[voice-call] User profile extraction failed (deps):`, err);
    return;
  }

  const workspaceDir = deps.resolveAgentWorkspaceDir(coreConfig, agentId);
  console.log(`[USER.md lifecycle] workspaceDir=${workspaceDir}`);
  await deps.ensureAgentWorkspace({ dir: workspaceDir });

  // Read existing USER.md
  const userFilePath = path.join(workspaceDir, "USER.md");
  let existingContent = "";
  try {
    existingContent = await fsp.readFile(userFilePath, "utf-8");
    console.log(`[USER.md lifecycle] Read existing USER.md (${existingContent.length} chars)`);
  } catch {
    console.log(`[USER.md lifecycle] No existing USER.md — will create from scratch`);
  }

  const existingProfile = existingContent ? parseUserMarkdown(existingContent) : {};
  console.log(
    `[USER.md lifecycle] Existing profile: name=${existingProfile.name ?? "(empty)"} callName=${existingProfile.callName ?? "(empty)"} timezone=${existingProfile.timezone ?? "(empty)"} notes=${existingProfile.notes ? "yes" : "(empty)"} context=${existingProfile.context ? "yes" : "(empty)"}`,
  );

  // Skip if profile is already fully populated (all non-optional fields set)
  if (
    existingProfile.name &&
    existingProfile.callName &&
    existingProfile.timezone &&
    existingProfile.notes &&
    existingProfile.context
  ) {
    console.log(`[USER.md lifecycle] SKIP: profile already fully populated — all fields set`);
    return;
  }

  // Format transcript
  const transcriptText = callRecord.transcript
    .map((entry) => `${entry.speaker === "bot" ? "Agent" : "Caller"}: ${entry.text}`)
    .join("\n");

  const prompt = [
    `Extract user profile information from this phone call transcript.`,
    `Return ONLY a JSON object with fields you can confidently extract from the conversation.\n`,
    `Fields:`,
    `- "name": Their full name if stated`,
    `- "callName": What they prefer to be called (first name, nickname — whatever they used)`,
    `- "pronouns": If mentioned or clearly implied`,
    `- "timezone": Only if explicitly stated or strongly implied by context`,
    `- "notes": Quick facts worth remembering (job, family members mentioned, preferences)`,
    `- "context": What they care about — projects, interests, what they called about (1-2 sentences)\n`,
    `Only include fields supported by clear evidence in the transcript.`,
    `Do NOT guess or infer values not in the conversation.`,
    `Return valid JSON only, no markdown.\n`,
    `Transcript:\n${transcriptText}`,
  ].join("\n");

  console.log(
    `[USER.md lifecycle] Sending transcript (${callRecord.transcript.length} entries) to LLM for extraction...`,
  );

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
      sessionKey: `agent:${agentId}:user-profile:${callRecord.callId}`,
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
      runId: `user-profile:${callRecord.callId}`,
      lane: "voice",
      extraSystemPrompt:
        "Extract user profile data from this call transcript. Return valid JSON only.",
      agentDir,
    });

    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const rawResponse = texts.join(" ");
    console.log(`[USER.md lifecycle] LLM raw response: ${rawResponse.slice(0, 500)}`);
    if (!rawResponse) {
      console.warn(`[USER.md lifecycle] SKIP: agent returned no text`);
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
        `[voice-call] User profile extraction: failed to parse JSON: ${jsonStr.slice(0, 200)}`,
      );
      return;
    }

    // Build extracted profile from JSON
    const extractedProfile: UserProfile = {};
    if (typeof extracted.name === "string" && extracted.name.trim()) {
      extractedProfile.name = extracted.name.trim();
    }
    if (typeof extracted.callName === "string" && extracted.callName.trim()) {
      extractedProfile.callName = extracted.callName.trim();
    }
    if (typeof extracted.pronouns === "string" && extracted.pronouns.trim()) {
      extractedProfile.pronouns = extracted.pronouns.trim();
    }
    if (typeof extracted.timezone === "string" && extracted.timezone.trim()) {
      extractedProfile.timezone = extracted.timezone.trim();
    }
    if (typeof extracted.notes === "string" && extracted.notes.trim()) {
      extractedProfile.notes = extracted.notes.trim();
    }
    if (typeof extracted.context === "string" && extracted.context.trim()) {
      extractedProfile.context = extracted.context.trim();
    }

    console.log(
      `[USER.md lifecycle] Extracted profile: name=${extractedProfile.name ?? "(empty)"} callName=${extractedProfile.callName ?? "(empty)"} timezone=${extractedProfile.timezone ?? "(empty)"} notes=${extractedProfile.notes ? "yes" : "(empty)"} context=${extractedProfile.context ? "yes" : "(empty)"}`,
    );

    if (!userProfileHasValues(extractedProfile)) {
      console.log(`[USER.md lifecycle] SKIP: no values extracted from transcript`);
      return;
    }

    // Merge and write
    const merged = mergeUserProfiles(existingProfile, extractedProfile);
    const serialized = serializeUserMarkdown(merged);
    console.log(
      `[USER.md lifecycle] WRITING merged USER.md to ${userFilePath} (${serialized.length} chars)`,
    );
    console.log(
      `[USER.md lifecycle] Merged profile: name=${merged.name ?? "(empty)"} callName=${merged.callName ?? "(empty)"} timezone=${merged.timezone ?? "(empty)"}`,
    );
    await fsp.writeFile(userFilePath, serialized, "utf-8");

    // Clean up ephemeral session file (best-effort)
    try {
      if (fs.existsSync(sessionFile)) {
        await fsp.unlink(sessionFile);
      }
    } catch {
      // ignore
    }

    // Clean up session store entry (best-effort)
    const sessionKey = `agent:${agentId}:user-profile:${callRecord.callId}`;
    if (sessionStore[sessionKey]) {
      delete sessionStore[sessionKey];
      await deps.saveSessionStore(storePath, sessionStore).catch(() => {});
    }

    console.log(
      `[USER.md lifecycle] SUCCESS — user profile extracted and written for callId=${callRecord.callId}`,
    );
  } catch (err) {
    console.error(`[USER.md lifecycle] FAILED — user profile extraction error:`, err);
  }
}
