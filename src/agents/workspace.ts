import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { isSubagentSessionKey, isVoiceSessionKey } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { resolveWorkspaceTemplateDir } from "./workspace-templates.js";

// ---------------------------------------------------------------------------
// Workspace directory resolution
// ---------------------------------------------------------------------------

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
//
// Single source of truth for every workspace markdown file the agent knows
// about. Adding a new file means adding ONE entry here — the type, load list,
// session allowlists, and gateway API all derive from this table.
//
// Fields:
//   name       — Filename on disk (e.g. "AGENTS.md").
//   required   — If true, `ensureAgentWorkspace` writes a template on first
//                run and `loadWorkspaceBootstrapFiles` always includes it
//                (even if missing). If false, the file is only included when
//                it exists on disk.
//   template   — If true AND required, there's a matching template in
//                docs/reference/templates/ that seeds the initial file.
//   sessions   — Which session types can see this file:
//                  "main"     — normal chat sessions (the default).
//                  "subagent" — LLM-spawned sub-tasks (minimal context).
//                  "voice"    — phone/voice call sessions.
//                Files with no session restrictions get all three.
//   notes      — Human-readable explanation of where the file comes from
//                and what it's for.
//
// IMPORTANT: Order matters — files are loaded in this order, which is the
// order they appear in the system prompt. Put the most important context
// first.
// ---------------------------------------------------------------------------

type SessionType = "main" | "subagent" | "voice";

type BootstrapFileEntry = {
  readonly name: string;
  readonly required: boolean;
  readonly template: boolean;
  readonly sessions: readonly SessionType[];
  readonly notes: string;
};

/**
 * Canonical list of workspace bootstrap files.
 *
 * To add a new file:
 * 1. Add an entry here.
 * 2. If `required: true` and `template: true`, add a template in
 *    docs/reference/templates/<name>.
 * 3. That's it — the type, loaders, session filters, and gateway API all
 *    derive from this array automatically.
 */
export const BOOTSTRAP_FILE_REGISTRY: readonly BootstrapFileEntry[] = [
  // --- Core persona & instructions (templated on workspace creation) -------
  {
    name: "AGENTS.md",
    required: true,
    template: true,
    sessions: ["main", "subagent", "voice"],
    notes: "Agent routing config and multi-agent instructions.",
  },
  {
    name: "SOUL.md",
    required: true,
    template: true,
    sessions: ["main", "voice"],
    notes: "Personality, tone, and behavioral guidelines.",
  },
  {
    name: "TOOLS.md",
    required: true,
    template: true,
    sessions: ["main", "subagent", "voice"],
    notes: "Tool usage guidance and constraints.",
  },
  {
    name: "IDENTITY.md",
    required: true,
    template: true,
    sessions: ["main", "voice"],
    notes: "Agent name, owner, and branding.",
  },
  {
    name: "USER.md",
    required: true,
    template: true,
    sessions: ["main", "voice"],
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
    sessions: ["main", "voice"],
    notes: "First-run onboarding script. Removed once USER.md has real data.",
  },

  // --- Runtime files (created by hooks, plugins, or the agent itself) ------
  {
    name: "CALLS.md",
    required: false,
    template: false,
    sessions: ["main", "voice"],
    notes: "Voice call log. Written by the voice-call extension after each call.",
  },
  {
    name: "MEMORY.md",
    required: false,
    template: false,
    sessions: ["main"],
    notes:
      "Long-term memory store. Created by memory-core plugin. " +
      "Also checked as memory.md (lowercase) for backwards compatibility.",
  },
  {
    name: "OBSERVATIONS.md",
    required: false,
    template: false,
    sessions: ["main"],
    notes:
      "Auto-generated insights. Written by the observational-memory hook " + "every N agent turns.",
  },
  {
    name: "CALENDAR.md",
    required: false,
    template: false,
    sessions: ["main", "voice"],
    notes: "Cached Google Calendar events. Written every 30 min by the " + "calendar-cache plugin.",
  },
] as const;

// ---------------------------------------------------------------------------
// Derived constants (backwards-compatible exports)
// ---------------------------------------------------------------------------
//
// Many files across the codebase import these individual constants. We keep
// them as simple re-exports derived from the registry so existing imports
// don't break.
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

// memory.md (lowercase) is a backwards-compat alias — not in the registry
// because it's a duplicate path for the same logical file.
export const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";

// ---------------------------------------------------------------------------
// Derived type
// ---------------------------------------------------------------------------

export type WorkspaceBootstrapFileName =
  | (typeof BOOTSTRAP_FILE_REGISTRY)[number]["name"]
  | typeof DEFAULT_MEMORY_ALT_FILENAME;

// ---------------------------------------------------------------------------
// Derived session filters
// ---------------------------------------------------------------------------
//
// Built from the registry's `sessions` field so we never have to maintain
// separate allowlist Sets by hand.
// ---------------------------------------------------------------------------

function buildSessionAllowlist(sessionType: SessionType): Set<string> {
  return new Set(
    BOOTSTRAP_FILE_REGISTRY.filter((e) => e.sessions.includes(sessionType)).map((e) => e.name),
  );
}

const SUBAGENT_BOOTSTRAP_ALLOWLIST = buildSessionAllowlist("subagent");
const VOICE_BOOTSTRAP_ALLOWLIST = buildSessionAllowlist("voice");

// ---------------------------------------------------------------------------
// Bootstrap file types
// ---------------------------------------------------------------------------

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Workspace creation (ensures required files exist)
// ---------------------------------------------------------------------------
//
// Only files with `required: true` and `template: true` in the registry are
// seeded here. Optional/runtime files are never created by this function —
// they appear when their respective plugin or hook first writes them.
// ---------------------------------------------------------------------------

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

  // Only required+templated files get written on workspace creation.
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
    // BOOTSTRAP.md is only written for brand-new workspaces — existing
    // workspaces that already went through onboarding don't need it.
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

// ---------------------------------------------------------------------------
// Bootstrap file loading
// ---------------------------------------------------------------------------
//
// Loads all workspace files for the agent's system prompt. Required files are
// always included (marked `missing: true` if absent). Optional files are only
// included when they exist on disk.
//
// Special case: MEMORY.md also checks for memory.md (lowercase) as a
// backwards-compat alias. If both exist and resolve to the same inode, only
// one is included.
// ---------------------------------------------------------------------------

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

  // Deduplicate in case MEMORY.md and memory.md are the same file (symlink).
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

  // Start with required files — always included (even if missing on disk).
  const entries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
  }> = BOOTSTRAP_FILE_REGISTRY.filter((e) => e.required).map((e) => ({
    name: e.name as WorkspaceBootstrapFileName,
    filePath: path.join(resolvedDir, e.name),
  }));

  // Memory files get special handling (lowercase alias + dedup).
  entries.push(...(await resolveMemoryBootstrapEntries(resolvedDir)));

  // Optional files — only included when they exist on disk.
  const optionalFiles = BOOTSTRAP_FILE_REGISTRY.filter(
    (e) => !e.required && e.name !== DEFAULT_MEMORY_FILENAME,
  );
  for (const entry of optionalFiles) {
    const filePath = path.join(resolvedDir, entry.name);
    try {
      await fs.access(filePath);
      entries.push({ name: entry.name as WorkspaceBootstrapFileName, filePath });
    } catch {
      // Not yet created — skip silently.
    }
  }

  // Read content for each entry.
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

// ---------------------------------------------------------------------------
// Session-based file filtering
// ---------------------------------------------------------------------------
//
// Different session types see different subsets of workspace files. The
// allowlists are derived from the registry's `sessions` field (see
// buildSessionAllowlist above).
//
// - "main" sessions see everything (no filter applied).
// - "subagent" sessions see only files tagged with "subagent" (minimal
//   context to reduce token usage in sub-tasks).
// - "voice" sessions see only files tagged with "voice" (relevant context
//   for phone calls — no HEARTBEAT, OBSERVATIONS, etc.).
// ---------------------------------------------------------------------------

export function filterBootstrapFilesForSession(
  files: WorkspaceBootstrapFile[],
  sessionKey?: string,
): WorkspaceBootstrapFile[] {
  if (!sessionKey) {
    return files;
  }
  if (isSubagentSessionKey(sessionKey)) {
    return files.filter((file) => SUBAGENT_BOOTSTRAP_ALLOWLIST.has(file.name));
  }
  if (isVoiceSessionKey(sessionKey)) {
    return files.filter((file) => VOICE_BOOTSTRAP_ALLOWLIST.has(file.name));
  }
  return files;
}
