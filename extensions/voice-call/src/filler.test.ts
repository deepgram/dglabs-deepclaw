import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateFillerPhrase } from "./filler.js";

describe("generateFillerPhrase", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("returns a generated phrase on success (tool context)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [{ type: "text", text: "Let me look up that order for you. " }],
        }),
    });

    const result = await generateFillerPhrase(
      { toolName: "lookup_order", args: { orderId: "123" } },
      "test-api-key",
    );

    expect(result).toBe("Let me look up that order for you.");
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options.method).toBe("POST");
    expect(options.headers["x-api-key"]).toBe("test-api-key");
    expect(options.headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(options.body);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.max_tokens).toBe(50);
    expect(body.messages[0].content).toContain("lookup_order");
  });

  it("returns a generated phrase on success (user message context)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [{ type: "text", text: "Let me think about that. " }],
        }),
    });

    const result = await generateFillerPhrase(
      { userMessage: "What is the weather like today?" },
      "test-api-key",
    );

    expect(result).toBe("Let me think about that.");
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
    expect(body.messages[0].content).toContain("What is the weather like today?");
  });

  it("returns null on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await generateFillerPhrase({ toolName: "test_fn" }, "test-api-key");

    expect(result).toBeNull();
  });

  it("returns null on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await generateFillerPhrase({ toolName: "test_fn" }, "test-api-key");

    expect(result).toBeNull();
  });

  it("returns null when API key is missing", async () => {
    globalThis.fetch = vi.fn();

    const result = await generateFillerPhrase({ toolName: "test_fn" }, "");

    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns null when response has no text content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [] }),
    });

    const result = await generateFillerPhrase({ toolName: "test_fn" }, "test-api-key");

    expect(result).toBeNull();
  });

  it("respects abort timeout", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation((_url: string, options: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });

    const promise = generateFillerPhrase({ toolName: "slow_fn" }, "test-api-key");

    // Advance past the 2000ms hard timeout
    await vi.advanceTimersByTimeAsync(2100);

    const result = await promise;
    expect(result).toBeNull();
  });
});
