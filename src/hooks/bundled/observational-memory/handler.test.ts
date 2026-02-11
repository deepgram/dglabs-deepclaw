import { describe, expect, it } from "vitest";
import { truncateAtMessageBoundary, validateObserverOutput } from "./handler.ts";

describe("validateObserverOutput", () => {
  it("rejects empty string", () => {
    const result = validateObserverOutput("", "existing content");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("empty output");
  });

  it("rejects whitespace-only string", () => {
    const result = validateObserverOutput("   \n\t  ", "existing content");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("empty output");
  });

  it("accepts new content when no existing content", () => {
    const result = validateObserverOutput("# Observations\n\nSome facts", "");
    expect(result.valid).toBe(true);
  });

  it("accepts new content when existing content is short (under 200 chars)", () => {
    const existing = "a".repeat(199);
    const result = validateObserverOutput("short", existing);
    expect(result.valid).toBe(true);
  });

  it("rejects drastically shorter output when existing is substantial", () => {
    const existing = "a".repeat(1000);
    const tooShort = "b".repeat(50); // 5% of existing, well below 30% threshold
    const result = validateObserverOutput(tooShort, existing);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("output too short");
    expect(result.reason).toContain("50 chars");
    expect(result.reason).toContain("1000 chars");
  });

  it("accepts output just above the ratio threshold", () => {
    const existing = "a".repeat(1000);
    const justAbove = "b".repeat(301); // 30.1%, just above 0.3
    const result = validateObserverOutput(justAbove, existing);
    expect(result.valid).toBe(true);
  });

  it("rejects output just below the ratio threshold", () => {
    const existing = "a".repeat(1000);
    const justBelow = "b".repeat(299); // 29.9%, just below 0.3
    const result = validateObserverOutput(justBelow, existing);
    expect(result.valid).toBe(false);
  });

  it("accepts output equal to existing length", () => {
    const existing = "a".repeat(500);
    const same = "b".repeat(500);
    const result = validateObserverOutput(same, existing);
    expect(result.valid).toBe(true);
  });

  it("accepts output longer than existing", () => {
    const existing = "a".repeat(500);
    const longer = "b".repeat(2000);
    const result = validateObserverOutput(longer, existing);
    expect(result.valid).toBe(true);
  });

  it("skips ratio check at exactly 200 chars existing", () => {
    const existing = "a".repeat(200);
    const short = "b".repeat(10); // 5% — would fail ratio, but existing is not > 200
    const result = validateObserverOutput(short, existing);
    expect(result.valid).toBe(true);
  });
});

describe("truncateAtMessageBoundary", () => {
  it("returns content unchanged when under the limit", () => {
    const content = "[user]: Hello\n\n[assistant]: Hi there";
    expect(truncateAtMessageBoundary(content, 1000)).toBe(content);
  });

  it("returns content unchanged when exactly at the limit", () => {
    const content = "x".repeat(100);
    expect(truncateAtMessageBoundary(content, 100)).toBe(content);
  });

  it("truncates at the last message boundary", () => {
    const msg1 = "[user]: First message";
    const msg2 = "[assistant]: Second message that is longer";
    const msg3 = "[user]: Third message with even more content here";
    const content = `${msg1}\n\n${msg2}\n\n${msg3}`;

    // Set limit so it cuts into msg3
    const limit = msg1.length + 2 + msg2.length + 10;
    const result = truncateAtMessageBoundary(content, limit);
    expect(result).toBe(`${msg1}\n\n${msg2}`);
  });

  it("returns raw truncation when no message boundary found", () => {
    const content = "a".repeat(200);
    const result = truncateAtMessageBoundary(content, 100);
    expect(result).toBe("a".repeat(100));
  });

  it("returns raw truncation when only boundary is at position 0", () => {
    // Content starts with \n\n[ but there's no earlier boundary
    const content = "\n\n[user]: Only message " + "x".repeat(200);
    const result = truncateAtMessageBoundary(content, 50);
    // lastIndexOf("\n\n[") finds position 0, but we require > 0
    expect(result).toBe(content.slice(0, 50));
  });

  it("handles multiple boundaries and picks the last one within limit", () => {
    const msgs = [
      "[user]: msg1",
      "[assistant]: msg2",
      "[user]: msg3",
      "[assistant]: msg4 with lots of extra content",
    ];
    const content = msgs.join("\n\n");

    // Limit cuts into msg4
    const limit = content.length - 10;
    const result = truncateAtMessageBoundary(content, limit);
    expect(result).toBe(`${msgs[0]}\n\n${msgs[1]}\n\n${msgs[2]}`);
  });
});
