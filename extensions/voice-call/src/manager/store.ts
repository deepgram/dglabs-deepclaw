import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CallerHistoryConfig } from "../config.js";
import { CallRecordSchema, TerminalStates, type CallId, type CallRecord } from "../types.js";

export type CallerHistoryEntry = {
  callId: string;
  startedAt: number;
  endedAt?: number;
  direction: string;
  excerpt: string;
};

export function persistCallRecord(storePath: string, call: CallRecord): void {
  const logPath = path.join(storePath, "calls.jsonl");
  const line = `${JSON.stringify(call)}\n`;
  // Fire-and-forget async write to avoid blocking event loop.
  fsp.appendFile(logPath, line).catch((err) => {
    console.error("[voice-call] Failed to persist call record:", err);
  });
}

export function loadActiveCallsFromStore(storePath: string): {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  processedEventIds: Set<string>;
} {
  const logPath = path.join(storePath, "calls.jsonl");
  if (!fs.existsSync(logPath)) {
    return {
      activeCalls: new Map(),
      providerCallIdMap: new Map(),
      processedEventIds: new Set(),
    };
  }

  const content = fs.readFileSync(logPath, "utf-8");
  const lines = content.split("\n");

  const callMap = new Map<CallId, CallRecord>();
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const call = CallRecordSchema.parse(JSON.parse(line));
      callMap.set(call.callId, call);
    } catch {
      // Skip invalid lines.
    }
  }

  const activeCalls = new Map<CallId, CallRecord>();
  const providerCallIdMap = new Map<string, CallId>();
  const processedEventIds = new Set<string>();

  for (const [callId, call] of callMap) {
    if (TerminalStates.has(call.state)) {
      continue;
    }
    activeCalls.set(callId, call);
    if (call.providerCallId) {
      providerCallIdMap.set(call.providerCallId, callId);
    }
    for (const eventId of call.processedEventIds) {
      processedEventIds.add(eventId);
    }
  }

  return { activeCalls, providerCallIdMap, processedEventIds };
}

export async function getCallHistoryFromStore(
  storePath: string,
  limit = 50,
): Promise<CallRecord[]> {
  const logPath = path.join(storePath, "calls.jsonl");

  try {
    await fsp.access(logPath);
  } catch {
    return [];
  }

  const content = await fsp.readFile(logPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const calls: CallRecord[] = [];

  for (const line of lines.slice(-limit)) {
    try {
      const parsed = CallRecordSchema.parse(JSON.parse(line));
      calls.push(parsed);
    } catch {
      // Skip invalid lines.
    }
  }

  return calls;
}

function buildExcerpt(call: CallRecord, maxChars: number): string {
  const lines: string[] = [];
  for (const entry of call.transcript) {
    if (!entry.isFinal) {
      continue;
    }
    const speaker = entry.speaker === "user" ? "Caller" : "Bot";
    lines.push(`${speaker}: ${entry.text}`);
  }
  const full = lines.join("\n");
  if (full.length <= maxChars) {
    return full;
  }
  return full.slice(0, maxChars) + "...";
}

export async function getCallerHistory(
  storePath: string,
  callerNumber: string,
  opts: CallerHistoryConfig,
): Promise<CallerHistoryEntry[]> {
  const logPath = path.join(storePath, "calls.jsonl");

  try {
    await fsp.access(logPath);
  } catch {
    return [];
  }

  const content = await fsp.readFile(logPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  const cutoff = Date.now() - opts.lookbackDays * 24 * 60 * 60 * 1000;
  // ~4 chars per token
  const maxChars = opts.summaryTokens * 4;

  const matching: CallRecord[] = [];
  for (const line of lines) {
    try {
      const call = CallRecordSchema.parse(JSON.parse(line));
      if (call.from !== callerNumber) {
        continue;
      }
      if (!TerminalStates.has(call.state)) {
        continue;
      }
      if (call.startedAt < cutoff) {
        continue;
      }
      matching.push(call);
    } catch {
      // Skip invalid lines.
    }
  }

  // Most recent first
  matching.sort((a, b) => b.startedAt - a.startedAt);

  // Cap at maxSessions
  const capped = matching.slice(0, opts.maxSessions);

  return capped.map((call) => ({
    callId: call.callId,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    direction: call.direction,
    excerpt: buildExcerpt(call, maxChars),
  }));
}
