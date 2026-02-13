import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { resolveWorkspaceTemplateDir } from "./workspace-templates.js";

export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const home = resolveRequiredHomeDir(env, homedir);
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", "workspace");
}

export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();

// ---------------------------------------------------------------------------
// Bootstrap file registry
// ---------------------------------------------------------------------------

type SessionType = "main" | "subagent";

type BootstrapFileEntry = {
  readonly name: string;
  readonly required: boolean;
  readonly template: boolean;
  readonly sessions: readonly SessionType[];
  readonly notes: string;
};

export const BOOTSTRAP_FILE_REGISTRY: readonly BootstrapFileEntry[] = [
  {
    name: "AGENTS.md",
    required: true,
    template: true,
    sessions: ["main", "subagent"],
    notes: "Agent routing config and multi-agent instructions.",
  },
  {
    name: "SOUL.md",
    required: true,
    template: true,
    sessions: ["main"],
    notes: "Personality, tone, and behavioral guidelines.",
  },
  {
    name: "TOOLS.md",
    required: true,
    template: true,
    sessions: ["main", "subagent"],
    notes: "Tool usage guidance and constraints.",
  },
  {
    name: "IDENTITY.md",
    required: true,
    template: true,
    sessions: ["main"],
    notes: "Agent name, owner, and branding.",
  },
  {
    name: "USER.md",
    required: true,
    template: true,
    sessions: ["main"],
    notes: "User profile built up over conversations.",
  },
  {
    name: "HEARTBEAT.md",
    required: true,
    template: true,
    sessions: ["main"],
    notes: "Proactive check-in schedule and cadence.",
  },
  {
    name: "BOOTSTRAP.md",
    required: true,
    template: true,
    sessions: ["main"],
    notes: "First-run onboarding script. Removed once USER.md has real data.",
  },
  {
    name: "CALLS.md",
    required: false,
    template: false,
    sessions: ["main"],
    notes: "Voice call log. Written by the voice-call extension after each call.",
  },
  {
    name: "MEMORY.md",
    required: false,
    template: false,
    sessions: ["main"],
    notes: "Long-term memory store. Created by memory-core plugin.",
  },
  {
    name: "OBSERVATIONS.md",
    required: false,
    template: false,
    sessions: ["main"],
    notes: "Auto-generated insights. Written by the observational-memory hook.",
  },
  {
    name: "CALENDAR.md",
    required: false,
    template: false,
    sessions: ["main"],
    notes: "Cached Google Calendar events. Written by the calendar-cache plugin.",
  },
] as const;

// ---------------------------------------------------------------------------
// Derived constants (backwards-compatible exports)
// ---------------------------------------------------------------------------

function findEntry(name: string): BootstrapFileEntry {
  const entry = BOOTSTRAP_FILE_REGISTRY.find((e) => e.name === name);
  if (!entry) {
    throw new Error(`Bootstrap file not in registry: ${name}`);
  }
  return entry;
}

export const DEFAULT_AGENTS_FILENAME = findEntry("AGENTS.md").name;
export const DEFAULT_SOUL_FILENAME = findEntry("SOUL.md").name;
export const DEFAULT_TOOLS_FILENAME = findEntry("TOOLS.md").name;
export const DEFAULT_IDENTITY_FILENAME = findEntry("IDENTITY.md").name;
export const DEFAULT_USER_FILENAME = findEntry("USER.md").name;
export const DEFAULT_HEARTBEAT_FILENAME = findEntry("HEARTBEAT.md").name;
export const DEFAULT_BOOTSTRAP_FILENAME = findEntry("BOOTSTRAP.md").name;
export const DEFAULT_MEMORY_FILENAME = findEntry("MEMORY.md").name;
export const DEFAULT_CALLS_FILENAME = findEntry("CALLS.md").name;
export const DEFAULT_OBSERVATIONS_FILENAME = findEntry("OBSERVATIONS.md").name;
export const DEFAULT_CALENDAR_FILENAME = findEntry("CALENDAR.md").name;
export const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }
  const start = endIndex + "\n---".length;
  let trimmed = content.slice(start);
  trimmed = trimmed.replace(/^\s+/, "");
  return trimmed;
}

async function loadTemplate(name: string): Promise<string> {
  const templateDir = await resolveWorkspaceTemplateDir();
  const templatePath = path.join(templateDir, name);
  try {
    const content = await fs.readFile(templatePath, "utf-8");
    return stripFrontMatter(content);
  } catch {
    throw new Error(
      `Missing workspace template: ${name} (${templatePath}). Ensure docs/reference/templates are packaged.`,
    );
  }
}

export type WorkspaceBootstrapFileName =
  | (typeof BOOTSTRAP_FILE_REGISTRY)[number]["name"]
  | typeof DEFAULT_MEMORY_ALT_FILENAME;

function buildSessionAllowlist(sessionType: SessionType): Set<string> {
  return new Set(
    BOOTSTRAP_FILE_REGISTRY.filter((e) => e.sessions.includes(sessionType)).map((e) => e.name),
  );
}

const SUBAGENT_BOOTSTRAP_ALLOWLIST = buildSessionAllowlist("subagent");

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

async function writeFileIfMissing(filePath: string, content: string) {
  try {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") {
      throw err;
    }
  }
}

async function hasGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isGitAvailable(): Promise<boolean> {
  try {
    const result = await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function ensureGitRepo(dir: string, isBrandNewWorkspace: boolean) {
  if (!isBrandNewWorkspace) {
    return;
  }
  if (await hasGitRepo(dir)) {
    return;
  }
  if (!(await isGitAvailable())) {
    return;
  }
  try {
    await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 10_000 });
  } catch {
    // Ignore git init failures; workspace creation should still succeed.
  }
}

export async function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureBootstrapFiles?: boolean;
}): Promise<{
  dir: string;
  agentsPath?: string;
  soulPath?: string;
  toolsPath?: string;
  identityPath?: string;
  userPath?: string;
  heartbeatPath?: string;
  bootstrapPath?: string;
}> {
  const rawDir = params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);
  await fs.mkdir(dir, { recursive: true });

  if (!params?.ensureBootstrapFiles) {
    return { dir };
  }

  const templatedFiles = BOOTSTRAP_FILE_REGISTRY.filter((e) => e.required && e.template);
  const filePaths = new Map<string, string>();
  for (const entry of templatedFiles) {
    filePaths.set(entry.name, path.join(dir, entry.name));
  }

  const isBrandNewWorkspace = await (async () => {
    const existing = await Promise.all(
      Array.from(filePaths.values()).map(async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }),
    );
    return existing.every((v) => !v);
  })();

  for (const entry of templatedFiles) {
    const filePath = filePaths.get(entry.name)!;
    if (entry.name === DEFAULT_BOOTSTRAP_FILENAME && !isBrandNewWorkspace) {
      continue;
    }
    const template = await loadTemplate(entry.name);
    await writeFileIfMissing(filePath, template);
  }
  await ensureGitRepo(dir, isBrandNewWorkspace);

  return {
    dir,
    agentsPath: filePaths.get(DEFAULT_AGENTS_FILENAME),
    soulPath: filePaths.get(DEFAULT_SOUL_FILENAME),
    toolsPath: filePaths.get(DEFAULT_TOOLS_FILENAME),
    identityPath: filePaths.get(DEFAULT_IDENTITY_FILENAME),
    userPath: filePaths.get(DEFAULT_USER_FILENAME),
    heartbeatPath: filePaths.get(DEFAULT_HEARTBEAT_FILENAME),
    bootstrapPath: filePaths.get(DEFAULT_BOOTSTRAP_FILENAME),
  };
}

async function resolveMemoryBootstrapEntries(
  resolvedDir: string,
): Promise<Array<{ name: WorkspaceBootstrapFileName; filePath: string }>> {
  const candidates: WorkspaceBootstrapFileName[] = [
    DEFAULT_MEMORY_FILENAME,
    DEFAULT_MEMORY_ALT_FILENAME,
  ];
  const entries: Array<{ name: WorkspaceBootstrapFileName; filePath: string }> = [];
  for (const name of candidates) {
    const filePath = path.join(resolvedDir, name);
    try {
      await fs.access(filePath);
      entries.push({ name, filePath });
    } catch {
      // optional
    }
  }
  if (entries.length <= 1) {
    return entries;
  }

  const seen = new Set<string>();
  const deduped: Array<{ name: WorkspaceBootstrapFileName; filePath: string }> = [];
  for (const entry of entries) {
    let key = entry.filePath;
    try {
      key = await fs.realpath(entry.filePath);
    } catch {}
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export async function loadWorkspaceBootstrapFiles(dir: string): Promise<WorkspaceBootstrapFile[]> {
  const resolvedDir = resolveUserPath(dir);

  const entries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
  }> = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
    },
    {
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME),
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
  ];

  entries.push(...(await resolveMemoryBootstrapEntries(resolvedDir)));

  const result: WorkspaceBootstrapFile[] = [];
  for (const entry of entries) {
    try {
      const content = await fs.readFile(entry.filePath, "utf-8");
      result.push({
        name: entry.name,
        path: entry.filePath,
        content,
        missing: false,
      });
    } catch {
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }
  return result;
}

export function filterBootstrapFilesForSession(
  files: WorkspaceBootstrapFile[],
  sessionKey?: string,
): WorkspaceBootstrapFile[] {
  if (!sessionKey || !isSubagentSessionKey(sessionKey)) {
    return files;
  }
  return files.filter((file) => SUBAGENT_BOOTSTRAP_ALLOWLIST.has(file.name));
}
