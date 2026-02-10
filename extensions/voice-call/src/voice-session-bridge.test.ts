import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepgramVoiceAgentClient } from "./providers/deepgram-voice-agent.js";
import {
  registerVoiceSession,
  unregisterVoiceSession,
  injectMessageToVoiceSession,
  isActiveVoiceSession,
  getActiveVoiceSessionKeys,
} from "./voice-session-bridge.js";

function createMockClient(connected = true): DeepgramVoiceAgentClient {
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    injectAgentMessage: vi.fn(),
  } as unknown as DeepgramVoiceAgentClient;
}

describe("voice-session-bridge", () => {
  afterEach(() => {
    // Clean up all registered sessions between tests
    for (const key of getActiveVoiceSessionKeys()) {
      unregisterVoiceSession(key);
    }
  });

  it("registerVoiceSession adds a session and getActiveVoiceSessionKeys returns it", () => {
    const client = createMockClient();
    registerVoiceSession("agent:main:voice-call:123:456", client, "call-1");

    const keys = getActiveVoiceSessionKeys();
    expect(keys).toContain("agent:main:voice-call:123:456");
  });

  it("unregisterVoiceSession removes a session", () => {
    const client = createMockClient();
    registerVoiceSession("agent:main:voice-call:123:456", client, "call-1");
    unregisterVoiceSession("agent:main:voice-call:123:456");

    const keys = getActiveVoiceSessionKeys();
    expect(keys).not.toContain("agent:main:voice-call:123:456");
  });

  it("isActiveVoiceSession returns true for connected session", () => {
    const client = createMockClient(true);
    registerVoiceSession("agent:main:voice-call:123:456", client, "call-1");

    expect(isActiveVoiceSession("agent:main:voice-call:123:456")).toBe(true);
  });

  it("isActiveVoiceSession returns false for disconnected session", () => {
    const client = createMockClient(false);
    registerVoiceSession("agent:main:voice-call:123:456", client, "call-1");

    expect(isActiveVoiceSession("agent:main:voice-call:123:456")).toBe(false);
  });

  it("isActiveVoiceSession returns false for unknown session", () => {
    expect(isActiveVoiceSession("agent:main:voice-call:999:999")).toBe(false);
  });

  it("injectMessageToVoiceSession injects into connected session", () => {
    const client = createMockClient(true);
    registerVoiceSession("agent:main:voice-call:123:456", client, "call-1");

    const result = injectMessageToVoiceSession(
      "agent:main:voice-call:123:456",
      "Hello from subagent",
    );

    expect(result).toBe(true);
    expect(client.injectAgentMessage).toHaveBeenCalledWith("Hello from subagent");
  });

  it("injectMessageToVoiceSession returns false for disconnected session", () => {
    const client = createMockClient(false);
    registerVoiceSession("agent:main:voice-call:123:456", client, "call-1");

    const result = injectMessageToVoiceSession("agent:main:voice-call:123:456", "Hello");

    expect(result).toBe(false);
  });

  it("injectMessageToVoiceSession returns false for unknown session", () => {
    const result = injectMessageToVoiceSession("agent:main:voice-call:999:999", "Hello");

    expect(result).toBe(false);
  });

  it("multiple sessions can be registered", () => {
    const client1 = createMockClient();
    const client2 = createMockClient();
    registerVoiceSession("agent:billing:voice-call:100:200", client1, "call-1");
    registerVoiceSession("agent:support:voice-call:300:400", client2, "call-2");

    const keys = getActiveVoiceSessionKeys();
    expect(keys).toHaveLength(2);
    expect(keys).toContain("agent:billing:voice-call:100:200");
    expect(keys).toContain("agent:support:voice-call:300:400");
  });

  it("registering same key replaces previous session", () => {
    const client1 = createMockClient();
    const client2 = createMockClient();
    registerVoiceSession("agent:main:voice-call:123:456", client1, "call-1");
    registerVoiceSession("agent:main:voice-call:123:456", client2, "call-2");

    const keys = getActiveVoiceSessionKeys();
    expect(keys).toHaveLength(1);

    injectMessageToVoiceSession("agent:main:voice-call:123:456", "Hello");
    expect(client2.injectAgentMessage).toHaveBeenCalledWith("Hello");
    expect(client1.injectAgentMessage).not.toHaveBeenCalled();
  });
});
