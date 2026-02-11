import { describe, expect, it, vi } from "vitest";

vi.mock("./server-voice-stream.js", async () => {
  const actual = await vi.importActual("./server-voice-stream.js");
  return actual;
});

describe("server-voice-stream", () => {
  it("module exports createVoiceStreamUpgradeHandler", async () => {
    const mod = await import("./server-voice-stream.js");
    expect(typeof mod.createVoiceStreamUpgradeHandler).toBe("function");
  });

  it("module exports VOICE_STREAM_PATH constant", async () => {
    const mod = await import("./server-voice-stream.js");
    expect(mod.VOICE_STREAM_PATH).toBe("/voice/stream");
  });

  it("module exports VoiceStreamUpgradeHandler type via createVoiceStreamUpgradeHandler return", async () => {
    const mod = await import("./server-voice-stream.js");
    const handler = mod.createVoiceStreamUpgradeHandler({
      log: {
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => ({ info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) }),
      } as any,
    });
    expect(typeof handler).toBe("function");
  });

  it("handler returns false for non-matching paths", async () => {
    const mod = await import("./server-voice-stream.js");
    const handler = mod.createVoiceStreamUpgradeHandler({
      log: {
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => ({ info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) }),
      } as any,
    });

    const req = { url: "/some/other/path" } as any;
    const socket = {} as any;
    const head = Buffer.alloc(0);
    const wss = {} as any;

    expect(handler(req, socket, head, wss)).toBe(false);
  });

  it("handler returns true and rejects with 503 when no Deepgram key", async () => {
    // Ensure DEEPGRAM_API_KEY is not set
    const prev = process.env.DEEPGRAM_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;

    try {
      const mod = await import("./server-voice-stream.js");
      const warns: string[] = [];
      const handler = mod.createVoiceStreamUpgradeHandler({
        log: {
          info: () => {},
          warn: (msg: string) => warns.push(msg),
          error: () => {},
          child: () => ({ info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) }),
        } as any,
      });

      let written = "";
      let destroyed = false;
      const req = { url: "/voice/stream" } as any;
      const socket = {
        write: (data: string) => {
          written = data;
        },
        destroy: () => {
          destroyed = true;
        },
      } as any;
      const head = Buffer.alloc(0);
      const wss = {} as any;

      const result = handler(req, socket, head, wss);

      expect(result).toBe(true);
      expect(written).toContain("503");
      expect(destroyed).toBe(true);
      expect(warns.length).toBeGreaterThan(0);
    } finally {
      if (prev !== undefined) {
        process.env.DEEPGRAM_API_KEY = prev;
      }
    }
  });
});
