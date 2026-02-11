import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import { buildBootstrapContextFiles, resolveBootstrapMaxChars } from "./pi-embedded-helpers.js";
import { parseUserMarkdown, userProfileHasValues } from "./user-file.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_USER_FILENAME,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

export function makeBootstrapWarn(params: {
  sessionLabel: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  if (!params.warn) {
    return undefined;
  }
  return (message: string) => params.warn?.(`${message} (sessionKey=${params.sessionLabel})`);
}

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  let bootstrapFiles = filterBootstrapFilesForSession(
    await loadWorkspaceBootstrapFiles(params.workspaceDir),
    sessionKey,
  );

  // Voice-first: if USER.md has real data (e.g. from a phone call),
  // the bootstrap ritual is unnecessary — the agent already knows the user.
  const userFile = bootstrapFiles.find(
    (f) => f.name === DEFAULT_USER_FILENAME && !f.missing && f.content,
  );
  if (userFile?.content) {
    const profile = parseUserMarkdown(userFile.content);
    if (userProfileHasValues(profile)) {
      bootstrapFiles = bootstrapFiles.filter((f) => f.name !== DEFAULT_BOOTSTRAP_FILENAME);
    }
  }

  return applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
}

export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars: resolveBootstrapMaxChars(params.config),
    warn: params.warn,
  });
  return { bootstrapFiles, contextFiles };
}
