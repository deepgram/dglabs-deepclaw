import { describe, expect, it } from "vitest";
import {
  mergeUserProfiles,
  parseUserMarkdown,
  serializeUserMarkdown,
  userProfileHasValues,
} from "./user-file.js";

const EMPTY_TEMPLATE = `# USER.md - About Your Human

_Learn about the person you're helping. Update this as you go._

- **Name:**
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**
- **Notes:**

## Context

_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_

---

The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.
`;

describe("parseUserMarkdown", () => {
  it("parses empty template — all fields empty, hasValues returns false", () => {
    const parsed = parseUserMarkdown(EMPTY_TEMPLATE);
    expect(parsed).toEqual({});
    expect(userProfileHasValues(parsed)).toBe(false);
  });

  it("parses populated fields", () => {
    const content = `# USER.md - About Your Human

- **Name:** Bill Getman
- **What to call them:** Bill
- **Pronouns:** he/him
- **Timezone:** America/New_York
- **Notes:** Interested in cooking

## Context

Called asking about a chicken and rice recipe. Seems casual and direct.
`;
    const parsed = parseUserMarkdown(content);
    expect(parsed).toEqual({
      name: "Bill Getman",
      callName: "Bill",
      pronouns: "he/him",
      timezone: "America/New_York",
      notes: "Interested in cooking",
      context: "Called asking about a chicken and rice recipe. Seems casual and direct.",
    });
    expect(userProfileHasValues(parsed)).toBe(true);
  });

  it("parses partial profile (name only)", () => {
    const content = `# USER.md

- **Name:** Sarah
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**
- **Notes:**

## Context

_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_
`;
    const parsed = parseUserMarkdown(content);
    expect(parsed).toEqual({ name: "Sarah" });
    expect(userProfileHasValues(parsed)).toBe(true);
  });

  it("ignores placeholder values", () => {
    const content = `
- **Name:**
- **Pronouns:** _(optional)_
- **Notes:**

## Context

_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_
`;
    const parsed = parseUserMarkdown(content);
    expect(parsed).toEqual({});
    expect(userProfileHasValues(parsed)).toBe(false);
  });

  it("handles extra whitespace", () => {
    const content = `
-  **Name:**   Bill
-  **What to call them:**    Bill
`;
    const parsed = parseUserMarkdown(content);
    expect(parsed.name).toBe("Bill");
    expect(parsed.callName).toBe("Bill");
  });

  it("handles missing context heading", () => {
    const content = `
- **Name:** Bill
- **Notes:** Likes cooking
`;
    const parsed = parseUserMarkdown(content);
    expect(parsed).toEqual({ name: "Bill", notes: "Likes cooking" });
    expect(parsed.context).toBeUndefined();
  });

  it("stops context at horizontal rule", () => {
    const content = `## Context

Some context here.

---

Footer text should not be included.
`;
    const parsed = parseUserMarkdown(content);
    expect(parsed.context).toBe("Some context here.");
  });

  it("handles bold/italic formatting in values", () => {
    const content = `
- **Name:** *Bill*
- **What to call them:** _Billy_
`;
    const parsed = parseUserMarkdown(content);
    expect(parsed.name).toBe("Bill");
    expect(parsed.callName).toBe("Billy");
  });
});

describe("mergeUserProfiles", () => {
  it("preserves existing values and fills blanks", () => {
    const existing = { name: "Bill", callName: "Bill" };
    const extracted = { name: "William", timezone: "America/New_York", notes: "Likes cooking" };
    const merged = mergeUserProfiles(existing, extracted);
    expect(merged.name).toBe("Bill"); // existing wins
    expect(merged.callName).toBe("Bill"); // existing preserved
    expect(merged.timezone).toBe("America/New_York"); // blank filled
    expect(merged.notes).toBe("Likes cooking"); // blank filled
  });

  it("appends context without duplicating", () => {
    const existing = { context: "Interested in cooking." };
    const extracted = { context: "Works in tech." };
    const merged = mergeUserProfiles(existing, extracted);
    expect(merged.context).toBe("Interested in cooking.\nWorks in tech.");
  });

  it("does not duplicate existing context", () => {
    const existing = { context: "Interested in cooking." };
    const extracted = { context: "Interested in cooking." };
    const merged = mergeUserProfiles(existing, extracted);
    expect(merged.context).toBe("Interested in cooking.");
  });

  it("sets context when existing is empty", () => {
    const existing = {};
    const extracted = { context: "New context." };
    const merged = mergeUserProfiles(existing, extracted);
    expect(merged.context).toBe("New context.");
  });
});

describe("serializeUserMarkdown", () => {
  it("round-trips through parse", () => {
    const profile = {
      name: "Bill Getman",
      callName: "Bill",
      pronouns: "he/him",
      timezone: "America/New_York",
      notes: "Interested in cooking",
      context: "Called asking about a chicken and rice recipe.",
    };
    const serialized = serializeUserMarkdown(profile);
    const reparsed = parseUserMarkdown(serialized);
    expect(reparsed).toEqual(profile);
  });

  it("produces valid template for empty profile", () => {
    const serialized = serializeUserMarkdown({});
    const reparsed = parseUserMarkdown(serialized);
    expect(reparsed).toEqual({});
    expect(userProfileHasValues(reparsed)).toBe(false);
  });

  it("includes placeholder for missing pronouns", () => {
    const serialized = serializeUserMarkdown({ name: "Bill" });
    expect(serialized).toContain("**Pronouns:** _(optional)_");
  });

  it("includes placeholder for missing context", () => {
    const serialized = serializeUserMarkdown({ name: "Bill" });
    expect(serialized).toContain("What do they care about?");
  });
});
