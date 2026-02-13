import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  BOOTSTRAP_FILE_REGISTRY,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  resolveDefaultAgentWorkspaceDir,
} from "./workspace.js";

describe("resolveDefaultAgentWorkspaceDir", () => {
  it("uses OPENCLAW_HOME for default workspace resolution", () => {
    const dir = resolveDefaultAgentWorkspaceDir({
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv);

    expect(dir).toBe(path.join(path.resolve("/srv/openclaw-home"), ".openclaw", "workspace"));
  });
});

describe("loadWorkspaceBootstrapFiles", () => {
  it("includes MEMORY.md when present", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "MEMORY.md", content: "memory" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const memoryEntries = files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]?.missing).toBe(false);
    expect(memoryEntries[0]?.content).toBe("memory");
  });

  it("includes memory.md when MEMORY.md is absent", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "memory.md", content: "alt" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const memoryEntries = files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]?.missing).toBe(false);
    expect(memoryEntries[0]?.content).toBe("alt");
  });

  it("omits memory entries when no memory files exist", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const memoryEntries = files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

    expect(memoryEntries).toHaveLength(0);
  });

  it("includes optional CALLS.md when present on disk", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "CALLS.md", content: "call log" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const callsEntry = files.find((f) => f.name === "CALLS.md");

    expect(callsEntry).toBeDefined();
    expect(callsEntry?.missing).toBe(false);
    expect(callsEntry?.content).toBe("call log");
  });

  it("omits optional files when not present on disk", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const callsEntry = files.find((f) => f.name === "CALLS.md");
    const obsEntry = files.find((f) => f.name === "OBSERVATIONS.md");

    expect(callsEntry).toBeUndefined();
    expect(obsEntry).toBeUndefined();
  });
});

describe("BOOTSTRAP_FILE_REGISTRY", () => {
  it("has no duplicate names", () => {
    const names = BOOTSTRAP_FILE_REGISTRY.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all required files have templates", () => {
    const required = BOOTSTRAP_FILE_REGISTRY.filter((e) => e.required);
    for (const entry of required) {
      expect(entry.template).toBe(true);
    }
  });

  it("optional files include CALLS.md, OBSERVATIONS.md, CALENDAR.md", () => {
    const optional = BOOTSTRAP_FILE_REGISTRY.filter((e) => !e.required).map((e) => e.name);
    expect(optional).toContain("CALLS.md");
    expect(optional).toContain("OBSERVATIONS.md");
    expect(optional).toContain("CALENDAR.md");
  });
});

describe("filterBootstrapFilesForSession", () => {
  it("returns all files for non-subagent sessions", () => {
    const files = [
      { name: "AGENTS.md", path: "/w/AGENTS.md", missing: false },
      { name: "SOUL.md", path: "/w/SOUL.md", missing: false },
    ] as any[];
    expect(filterBootstrapFilesForSession(files, "main:abc")).toEqual(files);
  });
});
