import { describe, expect, it, vi } from "vitest";

// Mock the imports
vi.mock("./server-dictation.js", async () => {
  const actual = await vi.importActual("./server-dictation.js");
  return actual;
});

describe("server-dictation", () => {
  it("module exports createDictationUpgradeHandler", async () => {
    const mod = await import("./server-dictation.js");
    expect(typeof mod.createDictationUpgradeHandler).toBe("function");
  });

  it("module exports DICTATION_PATH constant", async () => {
    const mod = await import("./server-dictation.js");
    expect(mod.DICTATION_PATH).toBe("/dictation/stream");
  });
});
