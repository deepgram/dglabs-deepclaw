import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallerHistoryConfig } from "../config.js";
import type { CallRecord } from "../types.js";
import { getCallerHistory, getCallHistoryFromStore, loadActiveCallsFromStore } from "./store.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "voice-call-store-test-"));
}

function writeCallsJsonl(storePath: string, records: CallRecord[]): void {
  const logPath = path.join(storePath, "calls.jsonl");
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(logPath, lines);
}

function makeCallRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    providerCallId: "prov-1",
    provider: "twilio",
    direction: "inbound",
    state: "completed",
    from: "+15551234567",
    to: "+15550000000",
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    endReason: "completed",
    transcript: [],
    processedEventIds: [],
    ...overrides,
  };
}

describe("loadActiveCallsFromStore", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty maps when no file exists", () => {
    tempDir = makeTempDir();
    const result = loadActiveCallsFromStore(tempDir);

    expect(result.activeCalls.size).toBe(0);
    expect(result.providerCallIdMap.size).toBe(0);
    expect(result.processedEventIds.size).toBe(0);
  });

  it("loads only non-terminal calls", () => {
    tempDir = makeTempDir();
    writeCallsJsonl(tempDir, [
      makeCallRecord({ callId: "active-1", state: "answered" }),
      makeCallRecord({ callId: "done-1", state: "completed" }),
      makeCallRecord({ callId: "active-2", state: "ringing", providerCallId: "prov-2" }),
    ]);

    const result = loadActiveCallsFromStore(tempDir);

    expect(result.activeCalls.size).toBe(2);
    expect(result.activeCalls.has("active-1")).toBe(true);
    expect(result.activeCalls.has("active-2")).toBe(true);
    expect(result.activeCalls.has("done-1")).toBe(false);
  });

  it("maps providerCallId to callId", () => {
    tempDir = makeTempDir();
    writeCallsJsonl(tempDir, [
      makeCallRecord({ callId: "call-a", providerCallId: "prov-a", state: "active" }),
    ]);

    const result = loadActiveCallsFromStore(tempDir);

    expect(result.providerCallIdMap.get("prov-a")).toBe("call-a");
  });

  it("skips invalid JSON lines", () => {
    tempDir = makeTempDir();
    const logPath = path.join(tempDir, "calls.jsonl");
    fs.writeFileSync(
      logPath,
      `${JSON.stringify(makeCallRecord({ callId: "good", state: "active" }))}\n{INVALID_JSON}\n`,
    );

    const result = loadActiveCallsFromStore(tempDir);

    expect(result.activeCalls.size).toBe(1);
    expect(result.activeCalls.has("good")).toBe(true);
  });
});

describe("getCallHistoryFromStore", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array when no file exists", async () => {
    tempDir = makeTempDir();
    const result = await getCallHistoryFromStore(tempDir);

    expect(result).toEqual([]);
  });

  it("returns records up to limit", async () => {
    tempDir = makeTempDir();
    writeCallsJsonl(tempDir, [
      makeCallRecord({ callId: "c1" }),
      makeCallRecord({ callId: "c2" }),
      makeCallRecord({ callId: "c3" }),
    ]);

    const result = await getCallHistoryFromStore(tempDir, 2);

    expect(result).toHaveLength(2);
    expect(result[0]!.callId).toBe("c2");
    expect(result[1]!.callId).toBe("c3");
  });
});

describe("getCallerHistory", () => {
  let tempDir: string;

  const defaultOpts: CallerHistoryConfig = {
    lookbackDays: 30,
    maxSessions: 5,
    summaryTokens: 512,
  };

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array when no store file exists", async () => {
    tempDir = makeTempDir();
    const result = await getCallerHistory(tempDir, "+15551234567", defaultOpts);

    expect(result).toEqual([]);
  });

  it("filters by caller phone number", async () => {
    tempDir = makeTempDir();
    writeCallsJsonl(tempDir, [
      makeCallRecord({ callId: "c1", from: "+15551234567", state: "completed" }),
      makeCallRecord({ callId: "c2", from: "+15559999999", state: "completed" }),
      makeCallRecord({ callId: "c3", from: "+15551234567", state: "completed" }),
    ]);

    const result = await getCallerHistory(tempDir, "+15551234567", defaultOpts);

    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.callId);
    expect(ids).toContain("c1");
    expect(ids).toContain("c3");
  });

  it("only returns terminal (completed) calls", async () => {
    tempDir = makeTempDir();
    writeCallsJsonl(tempDir, [
      makeCallRecord({ callId: "c1", from: "+15551234567", state: "completed" }),
      makeCallRecord({ callId: "c2", from: "+15551234567", state: "active" }),
    ]);

    const result = await getCallerHistory(tempDir, "+15551234567", defaultOpts);

    expect(result).toHaveLength(1);
    expect(result[0]!.callId).toBe("c1");
  });

  it("respects lookbackDays window", async () => {
    tempDir = makeTempDir();
    const now = Date.now();
    writeCallsJsonl(tempDir, [
      makeCallRecord({
        callId: "recent",
        from: "+15551234567",
        state: "completed",
        startedAt: now - 1000 * 60 * 60, // 1 hour ago
      }),
      makeCallRecord({
        callId: "old",
        from: "+15551234567",
        state: "completed",
        startedAt: now - 1000 * 60 * 60 * 24 * 60, // 60 days ago
      }),
    ]);

    const result = await getCallerHistory(tempDir, "+15551234567", {
      ...defaultOpts,
      lookbackDays: 30,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.callId).toBe("recent");
  });

  it("caps results at maxSessions", async () => {
    tempDir = makeTempDir();
    const now = Date.now();
    writeCallsJsonl(
      tempDir,
      Array.from({ length: 10 }, (_, i) =>
        makeCallRecord({
          callId: `c${i}`,
          from: "+15551234567",
          state: "completed",
          startedAt: now - i * 1000,
        }),
      ),
    );

    const result = await getCallerHistory(tempDir, "+15551234567", {
      ...defaultOpts,
      maxSessions: 3,
    });

    expect(result).toHaveLength(3);
  });

  it("returns most recent calls first", async () => {
    tempDir = makeTempDir();
    const now = Date.now();
    writeCallsJsonl(tempDir, [
      makeCallRecord({
        callId: "older",
        from: "+15551234567",
        state: "completed",
        startedAt: now - 10_000,
      }),
      makeCallRecord({
        callId: "newer",
        from: "+15551234567",
        state: "completed",
        startedAt: now - 1000,
      }),
    ]);

    const result = await getCallerHistory(tempDir, "+15551234567", defaultOpts);

    expect(result[0]!.callId).toBe("newer");
    expect(result[1]!.callId).toBe("older");
  });

  it("builds transcript excerpts", async () => {
    tempDir = makeTempDir();
    writeCallsJsonl(tempDir, [
      makeCallRecord({
        callId: "c1",
        from: "+15551234567",
        state: "completed",
        transcript: [
          { timestamp: 1, speaker: "user", text: "Hello", isFinal: true },
          { timestamp: 2, speaker: "bot", text: "Hi there", isFinal: true },
          { timestamp: 3, speaker: "user", text: "partial...", isFinal: false },
        ],
      }),
    ]);

    const result = await getCallerHistory(tempDir, "+15551234567", defaultOpts);

    expect(result).toHaveLength(1);
    // Only final transcripts should be included
    expect(result[0]!.excerpt).toContain("Caller: Hello");
    expect(result[0]!.excerpt).toContain("Bot: Hi there");
    expect(result[0]!.excerpt).not.toContain("partial");
  });

  it("truncates excerpts to stay within summaryTokens budget", async () => {
    tempDir = makeTempDir();
    writeCallsJsonl(tempDir, [
      makeCallRecord({
        callId: "c1",
        from: "+15551234567",
        state: "completed",
        startedAt: Date.now(),
        transcript: [{ timestamp: 1, speaker: "user", text: "A".repeat(500), isFinal: true }],
      }),
    ]);

    // Very small token budget: 10 tokens = ~40 chars
    const result = await getCallerHistory(tempDir, "+15551234567", {
      ...defaultOpts,
      summaryTokens: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.excerpt.length).toBeLessThanOrEqual(43); // 40 + "..."
  });
});
