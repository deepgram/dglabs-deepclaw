import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTimerConfig } from "./config.js";
import { SessionTimers, type SessionTimerCallbacks } from "./session-timers.js";

function createConfig(overrides?: Partial<SessionTimerConfig>): SessionTimerConfig {
  return {
    enabled: true,
    responseReengageMs: 15_000,
    responseExitMs: 45_000,
    idlePromptMs: 30_000,
    idleExitMs: 15_000,
    responseReengageMessage: "Could you try asking differently?",
    responseExitMessage: "I can't respond right now. Goodbye.",
    idlePromptMessage: "Are you still there?",
    idleExitMessage: "I'll let you go. Goodbye.",
    ...overrides,
  };
}

function createCallbacks() {
  return {
    injectAgentMessage: vi.fn(),
    endCall: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  } satisfies SessionTimerCallbacks;
}

describe("SessionTimers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("response timeout", () => {
    it("fires re-engage at responseReengageMs", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(createConfig(), cb);

      timers.onUserSpoke();
      vi.advanceTimersByTime(15_000);

      expect(cb.injectAgentMessage).toHaveBeenCalledWith("Could you try asking differently?");
      expect(cb.endCall).not.toHaveBeenCalled();
    });

    it("fires exit at responseExitMs and calls endCall after 3s", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(createConfig(), cb);

      timers.onUserSpoke();
      vi.advanceTimersByTime(45_000);

      expect(cb.injectAgentMessage).toHaveBeenCalledWith("I can't respond right now. Goodbye.");
      expect(cb.endCall).not.toHaveBeenCalled();

      vi.advanceTimersByTime(3_000);
      expect(cb.endCall).toHaveBeenCalledOnce();
    });

    it("silent recovery: agentStartedSpeaking clears response timers", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(createConfig(), cb);

      timers.onUserSpoke();
      vi.advanceTimersByTime(10_000);

      // Agent starts speaking before 15s re-engage
      timers.onAgentStartedSpeaking();
      vi.advanceTimersByTime(40_000);

      // Neither re-engage nor exit should have fired
      expect(cb.injectAgentMessage).not.toHaveBeenCalled();
      expect(cb.endCall).not.toHaveBeenCalled();
    });

    it("user re-speaks restarts the response cycle", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(createConfig(), cb);

      timers.onUserSpoke();
      vi.advanceTimersByTime(10_000);

      // User speaks again — timers restart
      timers.onUserSpoke();
      vi.advanceTimersByTime(14_999);

      // Re-engage hasn't fired yet (only 14.999s since restart)
      expect(cb.injectAgentMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(cb.injectAgentMessage).toHaveBeenCalledWith("Could you try asking differently?");
    });
  });

  describe("idle caller detection", () => {
    it("fires prompt at idlePromptMs after agentAudioDone", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(createConfig(), cb);

      timers.onAgentAudioDone();
      vi.advanceTimersByTime(30_000);

      expect(cb.injectAgentMessage).toHaveBeenCalledWith("Are you still there?");
      expect(cb.endCall).not.toHaveBeenCalled();
    });

    it("fires exit at idlePromptMs + idleExitMs and calls endCall after 3s", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(createConfig(), cb);

      timers.onAgentAudioDone();
      vi.advanceTimersByTime(30_000); // idle prompt
      vi.advanceTimersByTime(15_000); // idle exit

      expect(cb.injectAgentMessage).toHaveBeenCalledWith("I'll let you go. Goodbye.");

      vi.advanceTimersByTime(3_000);
      expect(cb.endCall).toHaveBeenCalledOnce();
    });

    it("user speech resets idle timers", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(createConfig(), cb);

      timers.onAgentAudioDone();
      vi.advanceTimersByTime(20_000);

      // User speaks — clears idle timers
      timers.onUserStartedSpeaking();
      vi.advanceTimersByTime(30_000);

      // No idle prompt because user spoke
      expect(cb.injectAgentMessage).not.toHaveBeenCalled();
    });

    it("idlePrompted guard prevents re-entrance from injected prompt agentAudioDone", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(
        createConfig({ idleExitMs: 60_000 }), // Long exit so it doesn't fire during the test
        cb,
      );

      timers.onAgentAudioDone();
      vi.advanceTimersByTime(30_000); // idle prompt fires

      expect(cb.injectAgentMessage).toHaveBeenCalledTimes(1);
      expect(cb.injectAgentMessage).toHaveBeenCalledWith("Are you still there?");

      // Simulate the prompt's own agentAudioDone — should NOT restart idle timer
      timers.onAgentAudioDone();
      vi.advanceTimersByTime(30_000);

      // Should still be just 1 call — the guard prevented re-entrance
      expect(cb.injectAgentMessage).toHaveBeenCalledTimes(1);
      expect(cb.endCall).not.toHaveBeenCalled();
    });
  });

  describe("disabled timers", () => {
    it("does nothing when enabled is false", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(createConfig({ enabled: false }), cb);

      timers.onUserSpoke();
      timers.onAgentAudioDone();
      vi.advanceTimersByTime(120_000);

      expect(cb.injectAgentMessage).not.toHaveBeenCalled();
      expect(cb.endCall).not.toHaveBeenCalled();
    });

    it("skips response timers when values are 0", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(
        createConfig({ responseReengageMs: 0, responseExitMs: 0 }),
        cb,
      );

      timers.onUserSpoke();
      vi.advanceTimersByTime(120_000);

      expect(cb.injectAgentMessage).not.toHaveBeenCalled();
      expect(cb.endCall).not.toHaveBeenCalled();
    });

    it("skips idle timers when idlePromptMs is 0", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(createConfig({ idlePromptMs: 0 }), cb);

      timers.onAgentAudioDone();
      vi.advanceTimersByTime(120_000);

      expect(cb.injectAgentMessage).not.toHaveBeenCalled();
      expect(cb.endCall).not.toHaveBeenCalled();
    });
  });

  describe("clearAll", () => {
    it("prevents all pending callbacks from firing", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(createConfig(), cb);

      timers.onUserSpoke();
      timers.onAgentAudioDone();

      // Clear before any timers fire
      timers.clearAll();
      vi.advanceTimersByTime(120_000);

      expect(cb.injectAgentMessage).not.toHaveBeenCalled();
      expect(cb.endCall).not.toHaveBeenCalled();
    });

    it("prevents further timer starts after clearAll", () => {
      const cb = createCallbacks();
      const timers = new SessionTimers(createConfig(), cb);

      timers.clearAll();

      // Try to start timers after clearAll — should be no-op due to exiting flag
      timers.onUserSpoke();
      timers.onAgentAudioDone();
      vi.advanceTimersByTime(120_000);

      expect(cb.injectAgentMessage).not.toHaveBeenCalled();
      expect(cb.endCall).not.toHaveBeenCalled();
    });
  });
});
