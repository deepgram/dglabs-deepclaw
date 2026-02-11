/**
 * Shared USER.md parser/serializer for the voice-call extension.
 *
 * Used by both user-profile-extraction.ts (post-call merge) and
 * deepgram-media-bridge.ts (caller context at call start).
 */

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

function normalizeValue(value: string): string {
  let n = value.trim();
  n = n.replace(/^[*_]+|[*_]+$/g, "").trim();
  if (n.startsWith("(") && n.endsWith(")")) {
    n = n.slice(1, -1).trim();
  }
  n = n.replace(/[\u2013\u2014]/g, "-");
  n = n.replace(/\s+/g, " ").toLowerCase();
  return n;
}

function isPlaceholder(value: string): boolean {
  return USER_PLACEHOLDER_VALUES.has(normalizeValue(value));
}

export function parseUserMarkdown(content: string): UserProfile {
  const profile: UserProfile = {};
  const lines = content.split(/\r?\n/);
  let contextStartIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+context/i.test(lines[i]!.trim())) {
      contextStartIndex = i + 1;
      break;
    }
  }
  const kvEnd = contextStartIndex === -1 ? lines.length : contextStartIndex - 1;
  for (let i = 0; i < kvEnd; i++) {
    const cleaned = lines[i]!.trim().replace(/^\s*-\s*/, "");
    const ci = cleaned.indexOf(":");
    if (ci === -1) continue;
    const label = cleaned.slice(0, ci).replace(/[*_]/g, "").trim().toLowerCase();
    const value = cleaned
      .slice(ci + 1)
      .replace(/^[*_]+|[*_]+$/g, "")
      .trim();
    if (!value || isPlaceholder(value)) continue;
    if (label === "name") profile.name = value;
    if (label === "what to call them") profile.callName = value;
    if (label === "pronouns") profile.pronouns = value;
    if (label === "timezone") profile.timezone = value;
    if (label === "notes") profile.notes = value;
  }
  if (contextStartIndex !== -1) {
    const ctxLines: string[] = [];
    for (let i = contextStartIndex; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^---\s*$/.test(line) || /^#\s/.test(line)) break;
      ctxLines.push(line);
    }
    const ctx = ctxLines.join("\n").trim();
    if (ctx && !isPlaceholder(ctx)) profile.context = ctx;
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
  if (!merged.name && extracted.name) merged.name = extracted.name;
  if (!merged.callName && extracted.callName) merged.callName = extracted.callName;
  if (!merged.pronouns && extracted.pronouns) merged.pronouns = extracted.pronouns;
  if (!merged.timezone && extracted.timezone) merged.timezone = extracted.timezone;
  if (!merged.notes && extracted.notes) merged.notes = extracted.notes;
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
