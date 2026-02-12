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
  const allFiles = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  console.log(
    `[USER.md lifecycle] resolveBootstrapFilesForRun — sessionKey=${sessionKey ?? "(none)"} agentId=${params.agentId ?? "(none)"} workspace=${params.workspaceDir} allFiles=[${allFiles.map((f) => `${f.name}(${f.missing ? "missing" : "ok"})`).join(", ")}]`,
  );
  let bootstrapFiles = filterBootstrapFilesForSession(allFiles, sessionKey);
  console.log(
    `[USER.md lifecycle] After session filter — files=[${bootstrapFiles.map((f) => f.name).join(", ")}]`,
  );

  // Voice-first: if USER.md has real data (e.g. from a phone call),
  // the bootstrap ritual is unnecessary — the agent already knows the user.
  const userFile = bootstrapFiles.find(
    (f) => f.name === DEFAULT_USER_FILENAME && !f.missing && f.content,
  );
  if (userFile?.content) {
    const profile = parseUserMarkdown(userFile.content);
    const hasValues = userProfileHasValues(profile);
    console.log(
      `[USER.md lifecycle] USER.md found in bootstrap — hasValues=${hasValues} name=${profile.name ?? "(empty)"} callName=${profile.callName ?? "(empty)"}`,
    );
    if (hasValues) {
      bootstrapFiles = bootstrapFiles.filter((f) => f.name !== DEFAULT_BOOTSTRAP_FILENAME);
      console.log(`[USER.md lifecycle] Removed BOOTSTRAP.md — user already known`);
    }
  } else {
    console.log(`[USER.md lifecycle] No USER.md with content in bootstrap files`);
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
