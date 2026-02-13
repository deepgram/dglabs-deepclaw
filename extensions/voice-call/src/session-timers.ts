/**
 * Session Timers
 *
 * Per-session timer manager for detecting unresponsive agents and idle callers.
 * Wired into Deepgram event handlers in the media bridge.
 *
 * Two independent timer chains:
 *
 * **Response timeout** (LLM stalls):
 *   User speaks → start timers
 *   - responseReengageMs: inject re-engage message
 *   - responseExitMs: inject exit message → hangup
 *   agentStartedSpeaking at any point → cancel both (silent recovery)
 *   User speaks again → restart fresh cycle
 *
 * **Idle caller** (caller goes silent):
 *   agentAudioDone → start idle timer
 *   - idlePromptMs: inject prompt, set idlePrompted flag
 *   - idleExitMs after prompt: inject goodbye → hangup
 *   Any user speech → cancel, clear flag
 *   Guard: agentAudioDone from injected prompt does NOT restart idle timer
 */

import type { SessionTimerConfig } from "./config.js";

export interface SessionTimerCallbacks {
  injectAgentMessage: (msg: string) => void;
  endCall: () => Promise<void>;
  log: (msg: string) => void;
}

export class SessionTimers {
  private readonly config: SessionTimerConfig;
  private readonly callbacks: SessionTimerCallbacks;

  // Response timeout timers
  private responseReengageTimer: ReturnType<typeof setTimeout> | null = null;
  private responseExitTimer: ReturnType<typeof setTimeout> | null = null;

  // Idle caller timers
  private idlePromptTimer: ReturnType<typeof setTimeout> | null = null;
  private idleExitTimer: ReturnType<typeof setTimeout> | null = null;

  // Guard: prevent agentAudioDone from the idle prompt injection from restarting the idle timer
  private idlePrompted = false;

  // Track whether we're in the exit path to prevent further timer actions
  private exiting = false;

  constructor(config: SessionTimerConfig, callbacks: SessionTimerCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    callbacks.log(
      `[SessionTimers] Created — enabled=${config.enabled} responseReengageMs=${config.responseReengageMs} responseExitMs=${config.responseExitMs} idlePromptMs=${config.idlePromptMs} idleExitMs=${config.idleExitMs}`,
    );
  }

  /**
   * Called when the user speaks. Starts response timeout timers and clears idle timers.
   */
  onUserSpoke(): void {
    this.callbacks.log(
      `[SessionTimers] onUserSpoke — enabled=${this.config.enabled} exiting=${this.exiting}`,
    );
    if (!this.config.enabled || this.exiting) return;

    this.clearResponseTimers();
    this.clearIdleTimers();
    this.idlePrompted = false;

    // Start response re-engage timer
    if (this.config.responseReengageMs > 0) {
      this.responseReengageTimer = setTimeout(() => {
        if (this.exiting) return;
        this.callbacks.log("[SessionTimers] Response re-engage timeout — injecting message");
        this.callbacks.injectAgentMessage(this.config.responseReengageMessage);
      }, this.config.responseReengageMs);
    }

    // Start response exit timer
    if (this.config.responseExitMs > 0) {
      this.responseExitTimer = setTimeout(() => {
        if (this.exiting) return;
        this.exiting = true;
        this.clearResponseTimers();
        this.clearIdleTimers();
        this.callbacks.log("[SessionTimers] Response exit timeout — injecting exit message");
        this.callbacks.injectAgentMessage(this.config.responseExitMessage);
        setTimeout(() => {
          void this.callbacks.endCall();
        }, 3000);
      }, this.config.responseExitMs);
    }
  }

  /**
   * Called when the agent starts speaking. Clears response timers (silent recovery).
   */
  onAgentStartedSpeaking(): void {
    this.callbacks.log(
      `[SessionTimers] onAgentStartedSpeaking — enabled=${this.config.enabled} hasResponseTimers=${this.responseReengageTimer !== null || this.responseExitTimer !== null}`,
    );
    if (!this.config.enabled) return;
    this.clearResponseTimers();
  }

  /**
   * Called when the agent finishes sending audio. Starts idle caller timer.
   * Skipped if we just injected the idle prompt (idlePrompted guard).
   */
  onAgentAudioDone(): void {
    this.callbacks.log(
      `[SessionTimers] onAgentAudioDone — enabled=${this.config.enabled} exiting=${this.exiting} idlePrompted=${this.idlePrompted}`,
    );
    if (!this.config.enabled || this.exiting) return;

    // Guard: don't restart idle timer after the idle prompt itself
    if (this.idlePrompted) return;

    this.clearIdleTimers();

    if (this.config.idlePromptMs > 0) {
      this.idlePromptTimer = setTimeout(() => {
        if (this.exiting) return;
        this.idlePrompted = true;
        this.callbacks.log("[SessionTimers] Idle prompt timeout — injecting prompt");
        this.callbacks.injectAgentMessage(this.config.idlePromptMessage);

        // Start exit timer after prompt
        if (this.config.idleExitMs > 0) {
          this.idleExitTimer = setTimeout(() => {
            if (this.exiting) return;
            this.exiting = true;
            this.clearIdleTimers();
            this.clearResponseTimers();
            this.callbacks.log("[SessionTimers] Idle exit timeout — injecting exit message");
            this.callbacks.injectAgentMessage(this.config.idleExitMessage);
            setTimeout(() => {
              void this.callbacks.endCall();
            }, 3000);
          }, this.config.idleExitMs);
        }
      }, this.config.idlePromptMs);
    }
  }

  /**
   * Called when the user starts speaking. Clears idle timers and resets idlePrompted.
   */
  onUserStartedSpeaking(): void {
    this.callbacks.log(
      `[SessionTimers] onUserStartedSpeaking — enabled=${this.config.enabled} hasIdleTimers=${this.idlePromptTimer !== null || this.idleExitTimer !== null}`,
    );
    if (!this.config.enabled) return;
    this.clearIdleTimers();
    this.idlePrompted = false;
  }

  /**
   * Clear all timers. Called during cleanup (handleStop) or when exiting.
   */
  clearAll(): void {
    this.callbacks.log("[SessionTimers] clearAll called");
    this.exiting = true;
    this.clearResponseTimers();
    this.clearIdleTimers();
  }

  private clearResponseTimers(): void {
    if (this.responseReengageTimer) {
      clearTimeout(this.responseReengageTimer);
      this.responseReengageTimer = null;
    }
    if (this.responseExitTimer) {
      clearTimeout(this.responseExitTimer);
      this.responseExitTimer = null;
    }
  }

  private clearIdleTimers(): void {
    if (this.idlePromptTimer) {
      clearTimeout(this.idlePromptTimer);
      this.idlePromptTimer = null;
    }
    if (this.idleExitTimer) {
      clearTimeout(this.idleExitTimer);
      this.idleExitTimer = null;
    }
  }
}
