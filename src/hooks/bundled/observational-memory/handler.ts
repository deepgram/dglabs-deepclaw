/**
 * Observational Memory hook handler
 *
 * After each agent turn, extracts structured observations from the conversation
 * and maintains OBSERVATIONS.md in the workspace for bootstrap injection.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { resolveAgentDir } from "../../../agents/agent-scope.js";
import { runEmbeddedPiAgent } from "../../../agents/pi-embedded.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";
import {
  OBSERVER_SYSTEM_PROMPT,
  OBSERVER_USER_PROMPT_TEMPLATE,
  REFLECTOR_SYSTEM_PROMPT,
  REFLECTOR_USER_PROMPT_TEMPLATE,
} from "./prompts.js";

const log = createSubsystemLogger("hooks/observational-memory");

log.info("Observational memory hook loaded");

/**
 * In-memory turn counter per session key (resets on process restart, which is acceptable).
 * Entries are evicted when the map exceeds MAX_TURN_COUNTER_ENTRIES to prevent unbounded growth.
 */
const turnCounters = new Map<string, { count: number; lastSeen: number }>();
const MAX_TURN_COUNTER_ENTRIES = 500;

/** Prevent concurrent observer runs per workspace directory. */
const activeWorkspaces = new Set<string>();

const DEFAULT_MESSAGES = 20;
const DEFAULT_TRIGGER_EVERY_N_TURNS = 3;
const DEFAULT_MAX_OBSERVATIONS_CHARS = 15_000;
const DEFAULT_REFLECTOR_THRESHOLD_CHARS = 12_000;
const OBSERVER_TIMEOUT_MS = 30_000;
const MAX_SESSION_CONTENT_CHARS = 8_000;

/**
 * Minimum ratio of new content length to existing content length.
 * If the observer returns content shorter than this ratio * existing length,
 * we skip the write to prevent data loss from truncated/hallucinated output.
 */
const MIN_CONTENT_RATIO = 0.3;

type ObserverConfig = {
  messages: number;
  triggerEveryNTurns: number;
  maxObservationsChars: number;
  reflectorThresholdChars: number;
};

function resolveObserverConfig(cfg: OpenClawConfig | undefined): ObserverConfig {
  const hookConfig = resolveHookConfig(cfg, "observational-memory");
  return {
    messages:
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0
        ? hookConfig.messages
        : DEFAULT_MESSAGES,
    triggerEveryNTurns:
      typeof hookConfig?.triggerEveryNTurns === "number" && hookConfig.triggerEveryNTurns > 0
        ? hookConfig.triggerEveryNTurns
        : DEFAULT_TRIGGER_EVERY_N_TURNS,
    maxObservationsChars:
      typeof hookConfig?.maxObservationsChars === "number" && hookConfig.maxObservationsChars > 0
        ? hookConfig.maxObservationsChars
        : DEFAULT_MAX_OBSERVATIONS_CHARS,
    reflectorThresholdChars:
      typeof hookConfig?.reflectorThresholdChars === "number" &&
      hookConfig.reflectorThresholdChars > 0
        ? hookConfig.reflectorThresholdChars
        : DEFAULT_REFLECTOR_THRESHOLD_CHARS,
  };
}

/**
 * Evict oldest entries from turnCounters when it exceeds the size limit.
 */
function evictStaleCounters(): void {
  if (turnCounters.size <= MAX_TURN_COUNTER_ENTRIES) {
    return;
  }
  const entries = [...turnCounters.entries()].toSorted((a, b) => a[1].lastSeen - b[1].lastSeen);
  const toRemove = entries.slice(0, entries.length - MAX_TURN_COUNTER_ENTRIES);
  for (const [key] of toRemove) {
    turnCounters.delete(key);
  }
}

/**
 * Read recent user/assistant messages from a session JSONL file.
 */
async function getRecentSessionMessages(
  sessionFilePath: string,
  messageCount: number,
): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    const allMessages: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
        };
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          const role = msg.role;
          if ((role === "user" || role === "assistant") && msg.content) {
            const text = Array.isArray(msg.content)
              ? (msg.content as Array<{ type?: string; text?: string }>).find(
                  (c) => c.type === "text",
                )?.text
              : String(msg.content);
            if (text && !text.startsWith("/")) {
              allMessages.push(`[${role}]: ${text}`);
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    const recentMessages = allMessages.slice(-messageCount);
    return recentMessages.length > 0 ? recentMessages.join("\n\n") : null;
  } catch {
    return null;
  }
}

/**
 * Truncate session content at the last complete message boundary before maxChars.
 */
function truncateAtMessageBoundary(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  // Messages are separated by double newlines and start with [role]:
  const truncated = content.slice(0, maxChars);
  const lastBoundary = truncated.lastIndexOf("\n\n[");
  if (lastBoundary > 0) {
    return truncated.slice(0, lastBoundary);
  }
  return truncated;
}

/**
 * Read existing OBSERVATIONS.md content from workspace.
 */
async function readExistingObservations(workspaceDir: string): Promise<string> {
  const obsPath = path.join(workspaceDir, "OBSERVATIONS.md");
  try {
    return await fs.readFile(obsPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Write OBSERVATIONS.md to workspace atomically (write to temp, then rename).
 */
async function writeObservations(workspaceDir: string, content: string): Promise<void> {
  const obsPath = path.join(workspaceDir, "OBSERVATIONS.md");
  const tmpPath = obsPath + ".tmp";
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, obsPath);
}

/**
 * Validate observer output before writing. Returns true if the output looks sane.
 */
function validateObserverOutput(
  newContent: string,
  existingContent: string,
): { valid: boolean; reason?: string } {
  // New content should not be empty
  if (!newContent.trim()) {
    return { valid: false, reason: "empty output" };
  }

  // If existing content was substantial, new content should not be drastically shorter
  if (
    existingContent.length > 200 &&
    newContent.length < existingContent.length * MIN_CONTENT_RATIO
  ) {
    return {
      valid: false,
      reason: `output too short (${newContent.length} chars vs existing ${existingContent.length} chars, ratio ${(newContent.length / existingContent.length).toFixed(2)} < ${MIN_CONTENT_RATIO})`,
    };
  }

  return { valid: true };
}

/**
 * Run a one-off LLM call using a temporary session file.
 * Returns the text output or null on failure.
 */
async function runOneOffLLMCall(params: {
  label: string;
  systemPrompt: string;
  userPrompt: string;
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  agentDir: string;
  provider?: string;
  model?: string;
}): Promise<string | null> {
  let tempSessionFile: string | null = null;

  try {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${params.label}-`));
    tempSessionFile = path.join(tempDir, "session.jsonl");
    const runId = `${params.label}-${Date.now()}`;

    const result = await runEmbeddedPiAgent({
      sessionId: runId,
      sessionKey: `temp:${params.label}`,
      agentId: params.agentId,
      sessionFile: tempSessionFile,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.cfg,
      prompt: params.userPrompt,
      extraSystemPrompt: params.systemPrompt,
      disableTools: true,
      provider: params.provider,
      model: params.model,
      timeoutMs: OBSERVER_TIMEOUT_MS,
      runId,
    });

    if (result.payloads && result.payloads.length > 0) {
      const text = result.payloads[0]?.text;
      if (text?.trim()) {
        return text.trim();
      }
    }

    return null;
  } catch (err) {
    log.error(`${params.label} LLM call failed`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Main hook handler — runs after each agent turn completes.
 */
const observationalMemoryHandler: HookHandler = async (event) => {
  if (event.type !== "agent" || event.action !== "turn-complete") {
    return;
  }

  // Skip in test environments
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }

  const context = event.context || {};
  const cfg = context.cfg as OpenClawConfig | undefined;
  if (!cfg) {
    return;
  }

  // Check if observational memory is disabled via agent defaults config
  const omConfig = cfg.agents?.defaults?.observationalMemory;
  if (omConfig?.enabled === false) {
    return;
  }

  const observerConfig = resolveObserverConfig(cfg);
  const sessionKey = event.sessionKey;
  const sessionFile = context.sessionFile as string | undefined;
  const workspaceDir = context.workspaceDir as string | undefined;

  if (!sessionFile || !workspaceDir) {
    return;
  }

  // Turn counter gating — only run every N turns
  const now = Date.now();
  const entry = turnCounters.get(sessionKey);
  const currentCount = (entry?.count ?? 0) + 1;
  turnCounters.set(sessionKey, { count: currentCount, lastSeen: now });
  evictStaleCounters();

  if (currentCount % observerConfig.triggerEveryNTurns !== 0) {
    log.debug(`Turn ${currentCount}, skipping (runs every ${observerConfig.triggerEveryNTurns})`);
    return;
  }

  // Prevent concurrent observer runs for the same workspace (not just session)
  if (activeWorkspaces.has(workspaceDir)) {
    log.debug("Observer already running for this workspace, skipping");
    return;
  }

  activeWorkspaces.add(workspaceDir);
  try {
    await runObserverCycle({
      cfg,
      observerConfig,
      sessionKey,
      sessionFile,
      workspaceDir,
      context,
    });
  } finally {
    activeWorkspaces.delete(workspaceDir);
  }
};

async function runObserverCycle(params: {
  cfg: OpenClawConfig;
  observerConfig: ObserverConfig;
  sessionKey: string;
  sessionFile: string;
  workspaceDir: string;
  context: Record<string, unknown>;
}): Promise<void> {
  const { cfg, observerConfig, sessionFile, workspaceDir, context } = params;

  log.debug("Running observer cycle");

  // Read recent messages from session
  const sessionContent = await getRecentSessionMessages(sessionFile, observerConfig.messages);
  if (!sessionContent) {
    log.debug("No session content available");
    return;
  }

  // Read existing observations
  const existingObservations = await readExistingObservations(workspaceDir);

  // Resolve agent identity and model config
  const agentId = (context.agentId as string) ?? resolveAgentIdFromSessionKey(params.sessionKey);
  const agentDir = (context.agentDir as string) ?? resolveAgentDir(cfg, agentId);

  // Resolve observer model (prefer dedicated config, fall back to agent default)
  const omConfig = cfg.agents?.defaults?.observationalMemory;
  const observerProvider = omConfig?.provider;
  const observerModel = omConfig?.model;

  // Build observer prompt — truncate at message boundary to avoid cutting mid-message
  const truncatedContent = truncateAtMessageBoundary(sessionContent, MAX_SESSION_CONTENT_CHARS);
  const userPrompt = OBSERVER_USER_PROMPT_TEMPLATE.replace(
    "{{EXISTING_OBSERVATIONS}}",
    existingObservations || "(none yet)",
  ).replace("{{RECENT_MESSAGES}}", truncatedContent);

  // Run observer
  const newObservations = await runOneOffLLMCall({
    label: "observer",
    systemPrompt: OBSERVER_SYSTEM_PROMPT,
    userPrompt,
    cfg,
    agentId,
    workspaceDir,
    agentDir,
    provider: observerProvider,
    model: observerModel,
  });

  if (!newObservations) {
    log.debug("Observer returned no observations");
    return;
  }

  // Validate observer output before overwriting
  const validation = validateObserverOutput(newObservations, existingObservations);
  if (!validation.valid) {
    log.warn(`Observer output rejected: ${validation.reason}`);
    return;
  }

  // Write updated observations (atomic: write to .tmp then rename)
  await writeObservations(workspaceDir, newObservations);
  log.info("Observations updated", {
    chars: newObservations.length,
    path: path.join(workspaceDir, "OBSERVATIONS.md").replace(os.homedir(), "~"),
  });

  // Check if reflector consolidation is needed
  if (newObservations.length > observerConfig.reflectorThresholdChars) {
    log.debug("Observations exceed threshold, running reflector", {
      chars: newObservations.length,
      threshold: observerConfig.reflectorThresholdChars,
    });

    const reflectorPrompt = REFLECTOR_USER_PROMPT_TEMPLATE.replace(
      "{{CURRENT_CHARS}}",
      String(newObservations.length),
    )
      .replace("{{MAX_CHARS}}", String(observerConfig.maxObservationsChars))
      .replace("{{OBSERVATIONS}}", newObservations);

    const consolidated = await runOneOffLLMCall({
      label: "reflector",
      systemPrompt: REFLECTOR_SYSTEM_PROMPT,
      userPrompt: reflectorPrompt,
      cfg,
      agentId,
      workspaceDir,
      agentDir,
      provider: observerProvider,
      model: observerModel,
    });

    if (consolidated) {
      // Validate reflector output too
      const reflectorValidation = validateObserverOutput(consolidated, newObservations);
      if (!reflectorValidation.valid) {
        log.warn(`Reflector output rejected: ${reflectorValidation.reason}`);
        return;
      }

      await writeObservations(workspaceDir, consolidated);
      log.info("Observations consolidated by reflector", {
        beforeChars: newObservations.length,
        afterChars: consolidated.length,
      });

      // Warn if reflector failed to meet the target size
      if (consolidated.length > observerConfig.maxObservationsChars) {
        log.warn("Reflector output still exceeds maxObservationsChars", {
          chars: consolidated.length,
          max: observerConfig.maxObservationsChars,
        });
      }
    }
  }
}

export default observationalMemoryHandler;
