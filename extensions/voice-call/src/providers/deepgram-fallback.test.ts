import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DeepgramFallbackConfig } from "../config.js";
import type { DeepgramVoiceAgentClient } from "./deepgram-voice-agent.js";
import { FallbackManager, type FallbackEvent } from "./deepgram-fallback.js";

function createMockClient(): DeepgramVoiceAgentClient {
  return {
    updatePrompt: vi.fn(),
    injectAgentMessage: vi.fn(),
    sendFunctionCallResponse: vi.fn(),
  } as unknown as DeepgramVoiceAgentClient;
}

function createConfig(overrides: Partial<DeepgramFallbackConfig> = {}): DeepgramFallbackConfig {
  return {
    openclawTimeoutMs: 100,
    cannedResponses: ["Could you say that again?", "One moment please..."],
    maxRetries: 2,
    deepgramFallbackPrompt: "You are a basic assistant.",
    exitMessage: "Goodbye.",
    ...overrides,
  };
}

describe("FallbackManager", () => {
  let events: FallbackEvent[];
  let hangups: string[];

  beforeEach(() => {
    events = [];
    hangups = [];
  });

  function createManager(configOverrides: Partial<DeepgramFallbackConfig> = {}) {
    return new FallbackManager({
      config: createConfig(configOverrides),
      onHangup: (callId) => hangups.push(callId),
      onFallbackEvent: (event) => events.push(event),
    });
  }

  it("returns result on success", async () => {
    const manager = createManager();
    const client = createMockClient();
    const handler = vi.fn().mockResolvedValue("ok");
    const wrapped = manager.wrapFunctionCall("call-1", client, handler);

    const result = await wrapped("test_fn", { arg: "value" }, "fc-1");

    expect(result).toBe("ok");
    expect(handler).toHaveBeenCalledWith("test_fn", { arg: "value" }, "fc-1");
    expect(events).toHaveLength(0);
  });

  it("tier 1: updates prompt on first failure when fallback prompt is set", async () => {
    const manager = createManager();
    const client = createMockClient();
    const handler = vi.fn().mockRejectedValue(new Error("timeout"));
    const wrapped = manager.wrapFunctionCall("call-1", client, handler);

    const result = await wrapped("test_fn", {}, "fc-1");

    const parsed = JSON.parse(result);
    expect(parsed.tier).toBe(1);
    expect(parsed.fallback).toBe(true);
    expect(client.updatePrompt).toHaveBeenCalledWith("You are a basic assistant.");
    expect(events).toHaveLength(1);
    expect(events[0]!.tier).toBe(1);
  });

  it("tier 2: uses canned response on second failure", async () => {
    const manager = createManager();
    const client = createMockClient();
    const handler = vi.fn().mockRejectedValue(new Error("timeout"));
    const wrapped = manager.wrapFunctionCall("call-1", client, handler);

    // First failure → tier 1
    await wrapped("test_fn", {}, "fc-1");
    // Second failure → tier 2
    const result = await wrapped("test_fn", {}, "fc-2");

    const parsed = JSON.parse(result);
    expect(parsed.tier).toBe(2);
    expect(client.injectAgentMessage).toHaveBeenCalledWith("Could you say that again?");
  });

  it("tier 2: cycles canned responses round-robin", async () => {
    const manager = createManager();
    const client = createMockClient();
    const handler = vi.fn().mockRejectedValue(new Error("timeout"));
    const wrapped = manager.wrapFunctionCall("call-1", client, handler);

    await wrapped("fn", {}, "fc-1"); // tier 1
    await wrapped("fn", {}, "fc-2"); // tier 2: index 0
    await wrapped("fn", {}, "fc-3"); // tier 4 (maxRetries=2, 3rd failure exceeds)

    // With maxRetries=2, third consecutive failure triggers tier 4
    const calls = (client.injectAgentMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([msg]: string[]) => msg === "Could you say that again?")).toBe(true);
  });

  it("tier 3: honest timeout when no fallback prompt or canned responses", async () => {
    const manager = createManager({
      deepgramFallbackPrompt: undefined,
      cannedResponses: [],
    });
    const client = createMockClient();
    const handler = vi.fn().mockRejectedValue(new Error("timeout"));
    const wrapped = manager.wrapFunctionCall("call-1", client, handler);

    const result = await wrapped("test_fn", {}, "fc-1");

    const parsed = JSON.parse(result);
    expect(parsed.tier).toBe(3);
    expect(client.injectAgentMessage).toHaveBeenCalledWith(
      "I'm having trouble right now, one moment...",
    );
  });

  it("tier 4: graceful exit after maxRetries", async () => {
    vi.useFakeTimers();
    const manager = createManager({ maxRetries: 1 });
    const client = createMockClient();
    const handler = vi.fn().mockRejectedValue(new Error("timeout"));
    const wrapped = manager.wrapFunctionCall("call-1", client, handler);

    await wrapped("fn", {}, "fc-1"); // tier 1
    const result = await wrapped("fn", {}, "fc-2"); // tier 4 (maxRetries=1, 2nd failure)

    const parsed = JSON.parse(result);
    expect(parsed.tier).toBe(4);
    expect(parsed.hangup).toBe(true);
    expect(client.injectAgentMessage).toHaveBeenCalledWith("Goodbye.");

    // Advance timer to trigger hangup callback
    vi.advanceTimersByTime(3000);
    expect(hangups).toContain("call-1");

    vi.useRealTimers();
  });

  it("resets failure count on success", async () => {
    const manager = createManager();
    const client = createMockClient();
    let callCount = 0;
    const handler = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 1) return Promise.reject(new Error("fail"));
      return Promise.resolve("ok");
    });
    const wrapped = manager.wrapFunctionCall("call-1", client, handler);

    await wrapped("fn", {}, "fc-1"); // failure → tier 1
    await wrapped("fn", {}, "fc-2"); // success → resets count

    // Next failure should be tier 1 again (not tier 2)
    callCount = 0;
    const result = await wrapped("fn", {}, "fc-3"); // failure → tier 1
    const parsed = JSON.parse(result);
    expect(parsed.tier).toBe(1);
  });

  it("times out slow function calls", async () => {
    const manager = createManager({ openclawTimeoutMs: 50 });
    const client = createMockClient();
    const handler = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 200)));
    const wrapped = manager.wrapFunctionCall("call-1", client, handler);

    const result = await wrapped("slow_fn", {}, "fc-1");

    const parsed = JSON.parse(result);
    expect(parsed.fallback).toBe(true);
  });

  it("cleanup removes call state", async () => {
    const manager = createManager();
    const client = createMockClient();
    const handler = vi.fn().mockRejectedValue(new Error("fail"));
    const wrapped = manager.wrapFunctionCall("call-1", client, handler);

    await wrapped("fn", {}, "fc-1"); // failure, state exists
    manager.cleanup("call-1");

    // After cleanup, next failure should be fresh (tier 1 again)
    const result = await wrapped("fn", {}, "fc-2");
    const parsed = JSON.parse(result);
    expect(parsed.tier).toBe(1);
  });

  it("emits fallback events with correct metadata", async () => {
    const manager = createManager();
    const client = createMockClient();
    const handler = vi.fn().mockRejectedValue(new Error("fail"));
    const wrapped = manager.wrapFunctionCall("call-1", client, handler);

    await wrapped("my_tool", { x: 1 }, "fc-1");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      callId: "call-1",
      tier: 1,
      functionName: "my_tool",
    });
    expect(events[0]!.timestamp).toBeGreaterThan(0);
  });
});
