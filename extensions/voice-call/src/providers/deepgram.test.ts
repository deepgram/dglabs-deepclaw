import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DeepgramConfig } from "../config.js";
import { DeepgramProvider } from "./deepgram.js";

// Mock the DeepgramVoiceAgentClient so tests don't require a WebSocket
vi.mock("./deepgram-voice-agent.js", () => {
  const { EventEmitter } = require("node:events");

  class MockDeepgramVoiceAgentClient extends EventEmitter {
    connected = false;
    closed = false;

    async connect() {
      this.connected = true;
      this.emit("connected", "test-request-id");
      this.emit("settingsApplied");
    }

    sendAudio = vi.fn();
    updatePrompt = vi.fn();
    updateSpeak = vi.fn();
    injectAgentMessage = vi.fn();
    injectUserMessage = vi.fn();
    sendFunctionCallResponse = vi.fn();

    close() {
      this.closed = true;
      this.connected = false;
    }

    isConnected() {
      return this.connected;
    }
  }

  return { DeepgramVoiceAgentClient: MockDeepgramVoiceAgentClient };
});

function createConfig(): DeepgramConfig {
  return {
    apiKey: "test-key",
    stt: { model: "nova-3" },
    tts: { model: "aura-2-thalia-en" },
    language: "en",
    fallback: {
      openclawTimeoutMs: 5000,
      cannedResponses: [],
      maxRetries: 2,
    },
    latency: {
      fillerThresholdMs: 1500,
      fillerPhrases: [],
    },
  };
}

describe("DeepgramProvider", () => {
  it("requires apiKey", () => {
    expect(
      () => new DeepgramProvider({ ...createConfig(), apiKey: undefined } as DeepgramConfig),
    ).toThrow("Deepgram API key is required");
  });

  it("has name 'deepgram'", () => {
    const provider = new DeepgramProvider(createConfig());
    expect(provider.name).toBe("deepgram");
  });

  it("verifyWebhook always returns ok", () => {
    const provider = new DeepgramProvider(createConfig());
    const result = provider.verifyWebhook({
      headers: {},
      rawBody: "",
      url: "",
      method: "POST",
    });
    expect(result.ok).toBe(true);
  });

  it("parseWebhookEvent returns empty events", () => {
    const provider = new DeepgramProvider(createConfig());
    const result = provider.parseWebhookEvent({
      headers: {},
      rawBody: "",
      url: "",
      method: "POST",
    });
    expect(result.events).toEqual([]);
    expect(result.statusCode).toBe(200);
  });

  it("initiateCall creates a session and connects", async () => {
    const provider = new DeepgramProvider(createConfig());
    const result = await provider.initiateCall({
      callId: "call-1",
      from: "+15551234567",
      to: "+15559876543",
      webhookUrl: "https://example.com/webhook",
    });

    expect(result.providerCallId).toBe("dg-call-1");
    expect(result.status).toBe("initiated");
    expect(provider.getClient("call-1")).toBeDefined();
  });

  it("hangupCall closes the session", async () => {
    const provider = new DeepgramProvider(createConfig());
    await provider.initiateCall({
      callId: "call-1",
      from: "+15551234567",
      to: "+15559876543",
      webhookUrl: "https://example.com/webhook",
    });

    const client = provider.getClient("call-1");
    expect(client).toBeDefined();

    await provider.hangupCall({
      callId: "call-1",
      providerCallId: "dg-call-1",
      reason: "completed",
    });

    expect(provider.getClient("call-1")).toBeUndefined();
  });

  it("playTts injects agent message", async () => {
    const provider = new DeepgramProvider(createConfig());
    await provider.initiateCall({
      callId: "call-1",
      from: "+15551234567",
      to: "+15559876543",
      webhookUrl: "https://example.com/webhook",
    });

    await provider.playTts({
      callId: "call-1",
      providerCallId: "dg-call-1",
      text: "Hello there!",
    });

    const client = provider.getClient("call-1")!;
    expect(client.injectAgentMessage).toHaveBeenCalledWith("Hello there!");
  });

  it("playTts throws for unknown call", async () => {
    const provider = new DeepgramProvider(createConfig());
    await expect(
      provider.playTts({
        callId: "unknown",
        providerCallId: "dg-unknown",
        text: "Hello",
      }),
    ).rejects.toThrow("No active Deepgram session");
  });

  it("startListening and stopListening are no-ops", async () => {
    const provider = new DeepgramProvider(createConfig());
    // Should not throw
    await provider.startListening({ callId: "call-1", providerCallId: "dg-call-1" });
    await provider.stopListening({ callId: "call-1", providerCallId: "dg-call-1" });
  });

  it("sendAudio forwards to client", async () => {
    const provider = new DeepgramProvider(createConfig());
    await provider.initiateCall({
      callId: "call-1",
      from: "+15551234567",
      to: "+15559876543",
      webhookUrl: "https://example.com/webhook",
    });

    const audio = Buffer.from([1, 2, 3]);
    provider.sendAudio("call-1", audio);

    const client = provider.getClient("call-1")!;
    expect(client.sendAudio).toHaveBeenCalledWith(audio);
  });

  it("updatePrompt forwards to client", async () => {
    const provider = new DeepgramProvider(createConfig());
    await provider.initiateCall({
      callId: "call-1",
      from: "+15551234567",
      to: "+15559876543",
      webhookUrl: "https://example.com/webhook",
    });

    provider.updatePrompt("call-1", "New prompt");

    const client = provider.getClient("call-1")!;
    expect(client.updatePrompt).toHaveBeenCalledWith("New prompt");
  });

  it("closeAll closes all sessions", async () => {
    const provider = new DeepgramProvider(createConfig());
    await provider.initiateCall({
      callId: "call-1",
      from: "+15551234567",
      to: "+15559876543",
      webhookUrl: "https://example.com/webhook",
    });
    await provider.initiateCall({
      callId: "call-2",
      from: "+15551234567",
      to: "+15559876543",
      webhookUrl: "https://example.com/webhook",
    });

    provider.closeAll();

    expect(provider.getClient("call-1")).toBeUndefined();
    expect(provider.getClient("call-2")).toBeUndefined();
  });

  it("emits NormalizedEvent for user speech", async () => {
    const onEvent = vi.fn();
    const provider = new DeepgramProvider(createConfig(), { onEvent });

    await provider.initiateCall({
      callId: "call-1",
      from: "+15551234567",
      to: "+15559876543",
      webhookUrl: "https://example.com/webhook",
    });

    const client = provider.getClient("call-1")!;
    client.emit("conversationText", "user", "Hello there");

    expect(onEvent).toHaveBeenCalledWith(
      "call-1",
      expect.objectContaining({
        type: "call.speech",
        transcript: "Hello there",
        isFinal: true,
      }),
    );
  });

  it("emits NormalizedEvent for agent speech", async () => {
    const onEvent = vi.fn();
    const provider = new DeepgramProvider(createConfig(), { onEvent });

    await provider.initiateCall({
      callId: "call-1",
      from: "+15551234567",
      to: "+15559876543",
      webhookUrl: "https://example.com/webhook",
    });

    const client = provider.getClient("call-1")!;
    client.emit("conversationText", "assistant", "Hi, how can I help?");

    expect(onEvent).toHaveBeenCalledWith(
      "call-1",
      expect.objectContaining({
        type: "call.speaking",
        text: "Hi, how can I help?",
      }),
    );
  });

  it("forwards audio events", async () => {
    const onAudio = vi.fn();
    const provider = new DeepgramProvider(createConfig(), { onAudio });

    await provider.initiateCall({
      callId: "call-1",
      from: "+15551234567",
      to: "+15559876543",
      webhookUrl: "https://example.com/webhook",
    });

    const client = provider.getClient("call-1")!;
    const audioBuffer = Buffer.from([1, 2, 3]);
    client.emit("audio", audioBuffer);

    expect(onAudio).toHaveBeenCalledWith("call-1", audioBuffer);
  });
});
