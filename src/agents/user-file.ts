import fs from "node:fs";
import path from "node:path";
import { DEFAULT_USER_FILENAME } from "./workspace.js";

export type UserProfile = {
  name?: string;
  callName?: string;
  pronouns?: string;
  timezone?: string;
  notes?: string;
  context?: string;
};

const USER_PLACEHOLDER_VALUES = new Set([
  "optional",
  "what do they care about? what projects are they working on? what annoys them? what makes them laugh? build this over time.",
]);

function normalizeUserValue(value: string): string {
  let normalized = value.trim();
  // Strip surrounding markdown bold/italic markers
  normalized = normalized.replace(/^[*_]+|[*_]+$/g, "").trim();
  // Strip surrounding parens (e.g. "(optional)")
  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  // Normalize dashes and whitespace
  normalized = normalized.replace(/[\u2013\u2014]/g, "-");
  normalized = normalized.replace(/\s+/g, " ").toLowerCase();
  return normalized;
}

function isUserPlaceholder(value: string): boolean {
  const normalized = normalizeUserValue(value);
  return USER_PLACEHOLDER_VALUES.has(normalized);
}

export function parseUserMarkdown(content: string): UserProfile {
  const profile: UserProfile = {};
  const lines = content.split(/\r?\n/);

  // Find context section — everything after "## Context" heading
  let contextStartIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+context/i.test(lines[i].trim())) {
      contextStartIndex = i + 1;
      break;
    }
  }

  // Parse key-value lines (before context section if it exists)
  const kvEndIndex = contextStartIndex === -1 ? lines.length : contextStartIndex - 1;
  for (let i = 0; i < kvEndIndex; i++) {
    const line = lines[i];
    const cleaned = line.trim().replace(/^\s*-\s*/, "");
    const colonIndex = cleaned.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const label = cleaned.slice(0, colonIndex).replace(/[*_]/g, "").trim().toLowerCase();
    // Strip surrounding bold/italic markers — two passes to handle
    // `**Name:** *value*` where `**` from the label bleeds into the value.
    let value = cleaned
      .slice(colonIndex + 1)
      .replace(/^[*_]+|[*_]+$/g, "")
      .trim()
      .replace(/^[*_]+|[*_]+$/g, "")
      .trim();
    if (!value) {
      continue;
    }
    if (isUserPlaceholder(value)) {
      continue;
    }
    if (label === "name") {
      profile.name = value;
    }
    if (label === "what to call them") {
      profile.callName = value;
    }
    if (label === "pronouns") {
      profile.pronouns = value;
    }
    if (label === "timezone") {
      profile.timezone = value;
    }
    if (label === "notes") {
      profile.notes = value;
    }
  }

  // Parse context section
  if (contextStartIndex !== -1) {
    const contextLines: string[] = [];
    for (let i = contextStartIndex; i < lines.length; i++) {
      const line = lines[i];
      // Stop at a horizontal rule or next top-level heading
      if (/^---\s*$/.test(line) || /^#\s/.test(line)) {
        break;
      }
      contextLines.push(line);
    }
    const contextText = contextLines.join("\n").trim();
    if (contextText && !isUserPlaceholder(contextText)) {
      profile.context = contextText;
    }
  }

  return profile;
}

export function userProfileHasValues(profile: UserProfile): boolean {
  return Boolean(
    profile.name ||
    profile.callName ||
    profile.pronouns ||
    profile.timezone ||
    profile.notes ||
    profile.context,
  );
}

export function mergeUserProfiles(existing: UserProfile, extracted: UserProfile): UserProfile {
  const merged: UserProfile = { ...existing };

  // Existing values win — only fill blanks
  if (!merged.name && extracted.name) {
    merged.name = extracted.name;
  }
  if (!merged.callName && extracted.callName) {
    merged.callName = extracted.callName;
  }
  if (!merged.pronouns && extracted.pronouns) {
    merged.pronouns = extracted.pronouns;
  }
  if (!merged.timezone && extracted.timezone) {
    merged.timezone = extracted.timezone;
  }
  if (!merged.notes && extracted.notes) {
    merged.notes = extracted.notes;
  }

  // Context: append without duplicating
  if (extracted.context) {
    if (!merged.context) {
      merged.context = extracted.context;
    } else if (!merged.context.includes(extracted.context)) {
      merged.context = merged.context.trimEnd() + "\n" + extracted.context;
    }
  }

  return merged;
}

export function serializeUserMarkdown(profile: UserProfile): string {
  const lines: string[] = [];
  lines.push("# USER.md - About Your Human");
  lines.push("");
  lines.push("_Learn about the person you're helping. Update this as you go._");
  lines.push("");
  lines.push(`- **Name:** ${profile.name ?? ""}`);
  lines.push(`- **What to call them:** ${profile.callName ?? ""}`);
  lines.push(`- **Pronouns:** ${profile.pronouns ?? "_(optional)_"}`);
  lines.push(`- **Timezone:** ${profile.timezone ?? ""}`);
  lines.push(`- **Notes:** ${profile.notes ?? ""}`);
  lines.push("");
  lines.push("## Context");
  lines.push("");
  if (profile.context) {
    lines.push(profile.context);
  } else {
    lines.push(
      "_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_",
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.",
  );
  lines.push("");
  return lines.join("\n");
}

export function loadUserProfileFromWorkspace(workspace: string): UserProfile | null {
  const userPath = path.join(workspace, DEFAULT_USER_FILENAME);
  try {
    const content = fs.readFileSync(userPath, "utf-8");
    const parsed = parseUserMarkdown(content);
    if (!userProfileHasValues(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
