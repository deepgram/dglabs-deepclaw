import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

type FileMeta = {
  size: number;
  updatedAtMs: number;
};

async function statFile(filePath: string): Promise<FileMeta | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return {
      size: stat.size,
      updatedAtMs: Math.floor(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

type MemoryFileEntry = {
  name: string;
  path: string;
  size?: number;
  updatedAtMs?: number;
  pinned?: boolean;
};

async function listMemoryFiles(workspaceDir: string): Promise<MemoryFileEntry[]> {
  const files: MemoryFileEntry[] = [];

  const memoryMdPath = path.join(workspaceDir, "MEMORY.md");
  const memoryMdMeta = await statFile(memoryMdPath);
  if (memoryMdMeta) {
    files.push({
      name: "MEMORY.md",
      path: memoryMdPath,
      size: memoryMdMeta.size,
      updatedAtMs: memoryMdMeta.updatedAtMs,
      pinned: true,
    });
  }

  const memoryDir = path.join(workspaceDir, "memory");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(memoryDir);
  } catch {
    // Directory may not exist yet
  }

  const dailyFiles: MemoryFileEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const filePath = path.join(memoryDir, entry);
    const meta = await statFile(filePath);
    if (meta) {
      dailyFiles.push({
        name: entry,
        path: filePath,
        size: meta.size,
        updatedAtMs: meta.updatedAtMs,
      });
    }
  }

  dailyFiles.sort((a, b) => b.name.localeCompare(a.name));
  files.push(...dailyFiles);

  return files;
}

function isValidMemoryFileName(name: string): boolean {
  if (name === "MEMORY.md") {
    return true;
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return false;
  }
  return name.endsWith(".md");
}

function resolveMemoryFilePath(workspaceDir: string, name: string): string {
  if (name === "MEMORY.md") {
    return path.join(workspaceDir, "MEMORY.md");
  }
  return path.join(workspaceDir, "memory", name);
}

export const memoryHandlers: GatewayRequestHandlers = {
  "memory.files.list": async ({ respond }) => {
    const cfg = loadConfig();
    const defaultId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, defaultId);
    const files = await listMemoryFiles(workspaceDir);
    respond(true, { workspace: workspaceDir, files }, undefined);
  },

  "memory.files.get": async ({ params, respond }) => {
    const name = String(params.name ?? "").trim();
    if (!name || !isValidMemoryFileName(name)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `invalid file name "${name}"`),
      );
      return;
    }
    const cfg = loadConfig();
    const defaultId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, defaultId);
    const filePath = resolveMemoryFilePath(workspaceDir, name);
    const meta = await statFile(filePath);
    if (!meta) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `file not found: ${name}`));
      return;
    }
    const content = await fs.readFile(filePath, "utf-8");
    respond(
      true,
      {
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          size: meta.size,
          updatedAtMs: meta.updatedAtMs,
          pinned: name === "MEMORY.md",
          content,
        },
      },
      undefined,
    );
  },

  "memory.files.set": async ({ params, respond }) => {
    const name = String(params.name ?? "").trim();
    if (!name || !isValidMemoryFileName(name)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `invalid file name "${name}"`),
      );
      return;
    }
    const content = String(params.content ?? "");
    const cfg = loadConfig();
    const defaultId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, defaultId);
    const filePath = resolveMemoryFilePath(workspaceDir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    const meta = await statFile(filePath);
    respond(
      true,
      {
        ok: true,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          size: meta?.size,
          updatedAtMs: meta?.updatedAtMs,
          pinned: name === "MEMORY.md",
          content,
        },
      },
      undefined,
    );
  },
};
