/**
 * Graceful Degradation Chain for Deepgram Voice Calls
 *
 * Implements a 4-tier fallback when the primary function call handler
 * (OpenClaw tool execution) fails or times out:
 *
 *   Tier 1 — Deepgram LLM fallback: Switch to Deepgram's built-in LLM
 *            with a basic fallback prompt so the agent can still converse.
 *   Tier 2 — Canned response: Inject a pre-configured canned response.
 *   Tier 3 — Honest timeout: "I'm having trouble right now, one moment..."
 *   Tier 4 — Graceful exit: After maxRetries, speak exit message and hang up.
 *
 * Consecutive successes reset the failure counter.
 */

import type { DeepgramFallbackConfig } from "../config.js";
import type { DeepgramVoiceAgentClient } from "./deepgram-voice-agent.js";

const LOG_PREFIX = "[DeepgramFallback]";

const DEFAULT_TIMEOUT_MSG = "I'm having trouble right now, one moment...";

export type FallbackTier = 1 | 2 | 3 | 4;

export interface FallbackEvent {
  callId: string;
  tier: FallbackTier;
  functionName: string;
  message: string;
  timestamp: number;
}

export interface FallbackManagerOptions {
  config: DeepgramFallbackConfig;
  /** Called when a graceful exit (tier 4) triggers a hangup. */
  onHangup?: (callId: string) => void;
  /** Called when a fallback event occurs (for observability). */
  onFallbackEvent?: (event: FallbackEvent) => void;
}

interface CallFallbackState {
  consecutiveFailures: number;
  cannedResponseIndex: number;
}

export class FallbackManager {
  private readonly config: DeepgramFallbackConfig;
  private readonly callState = new Map<string, CallFallbackState>();
  private readonly options: FallbackManagerOptions;

  constructor(options: FallbackManagerOptions) {
    this.config = options.config;
    this.options = options;
  }

  /**
   * Wrap a function call handler with timeout and fallback logic.
   *
   * Returns a new handler that applies the timeout from config and
   * escalates through fallback tiers on failure.
   */
  wrapFunctionCall(
    callId: string,
    client: DeepgramVoiceAgentClient,
    handler: (name: string, args: Record<string, unknown>, fnCallId: string) => Promise<string>,
  ): (name: string, args: Record<string, unknown>, fnCallId: string) => Promise<string> {
    return async (name, args, fnCallId) => {
      const timeoutMs = this.config.openclawTimeoutMs;

      try {
        const result = await this.withTimeout(handler(name, args, fnCallId), timeoutMs);
        this.recordSuccess(callId);
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`${LOG_PREFIX} Function call "${name}" failed for call ${callId}: ${msg}`);

        return this.handleFailure(callId, client, name);
      }
    };
  }

  /**
   * Clean up state for a call that ended.
   */
  cleanup(callId: string): void {
    this.callState.delete(callId);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private getState(callId: string): CallFallbackState {
    let state = this.callState.get(callId);
    if (!state) {
      state = { consecutiveFailures: 0, cannedResponseIndex: 0 };
      this.callState.set(callId, state);
    }
    return state;
  }

  private recordSuccess(callId: string): void {
    const state = this.getState(callId);
    state.consecutiveFailures = 0;
  }

  private handleFailure(
    callId: string,
    client: DeepgramVoiceAgentClient,
    functionName: string,
  ): string {
    const state = this.getState(callId);
    state.consecutiveFailures++;

    const tier = this.determineTier(state);

    switch (tier) {
      case 1:
        return this.tier1FallbackPrompt(callId, client, functionName);
      case 2:
        return this.tier2CannedResponse(callId, client, functionName, state);
      case 3:
        return this.tier3HonestTimeout(callId, client, functionName);
      case 4:
        return this.tier4GracefulExit(callId, client, functionName);
    }
  }

  private determineTier(state: CallFallbackState): FallbackTier {
    const maxRetries = this.config.maxRetries;

    if (state.consecutiveFailures <= 1) {
      // First failure: try Deepgram LLM fallback if available
      if (this.config.deepgramFallbackPrompt) return 1;
      // No fallback prompt → skip to canned response
      if (this.config.cannedResponses.length > 0) return 2;
      return 3;
    }

    if (state.consecutiveFailures <= maxRetries) {
      // Subsequent failures: cycle through canned responses
      if (this.config.cannedResponses.length > 0) return 2;
      return 3;
    }

    // Exceeded max retries → graceful exit
    return 4;
  }

  /**
   * Tier 1: Switch to Deepgram's built-in LLM with a fallback prompt.
   * The agent can still converse using Deepgram's own model.
   */
  private tier1FallbackPrompt(
    callId: string,
    client: DeepgramVoiceAgentClient,
    functionName: string,
  ): string {
    const prompt = this.config.deepgramFallbackPrompt!;
    console.log(`${LOG_PREFIX} Tier 1: Updating prompt for call ${callId}`);
    client.updatePrompt(prompt);

    this.emitEvent(callId, 1, functionName, "Switched to fallback LLM prompt");

    return JSON.stringify({
      fallback: true,
      tier: 1,
      message: "Primary tool execution failed. Using fallback mode.",
    });
  }

  /**
   * Tier 2: Inject a canned response.
   * Cycles through the configured responses round-robin.
   */
  private tier2CannedResponse(
    callId: string,
    client: DeepgramVoiceAgentClient,
    functionName: string,
    state: CallFallbackState,
  ): string {
    const responses = this.config.cannedResponses;
    const response = responses[state.cannedResponseIndex % responses.length]!;
    state.cannedResponseIndex++;

    console.log(`${LOG_PREFIX} Tier 2: Canned response for call ${callId}: "${response}"`);
    client.injectAgentMessage(response);

    this.emitEvent(callId, 2, functionName, response);

    return JSON.stringify({
      fallback: true,
      tier: 2,
      message: response,
    });
  }

  /**
   * Tier 3: Honest timeout message.
   */
  private tier3HonestTimeout(
    callId: string,
    client: DeepgramVoiceAgentClient,
    functionName: string,
  ): string {
    console.log(`${LOG_PREFIX} Tier 3: Honest timeout for call ${callId}`);
    client.injectAgentMessage(DEFAULT_TIMEOUT_MSG);

    this.emitEvent(callId, 3, functionName, DEFAULT_TIMEOUT_MSG);

    return JSON.stringify({
      fallback: true,
      tier: 3,
      message: DEFAULT_TIMEOUT_MSG,
    });
  }

  /**
   * Tier 4: Graceful exit. Speak exit message and request hangup.
   */
  private tier4GracefulExit(
    callId: string,
    client: DeepgramVoiceAgentClient,
    functionName: string,
  ): string {
    const exitMsg = this.config.exitMessage ?? "I apologize, I need to call you back. Goodbye.";

    console.log(`${LOG_PREFIX} Tier 4: Graceful exit for call ${callId}: "${exitMsg}"`);
    client.injectAgentMessage(exitMsg);

    this.emitEvent(callId, 4, functionName, exitMsg);

    // Schedule hangup after a short delay to let the exit message be spoken
    setTimeout(() => {
      this.options.onHangup?.(callId);
    }, 3000);

    return JSON.stringify({
      fallback: true,
      tier: 4,
      message: exitMsg,
      hangup: true,
    });
  }

  private emitEvent(
    callId: string,
    tier: FallbackTier,
    functionName: string,
    message: string,
  ): void {
    this.options.onFallbackEvent?.({
      callId,
      tier,
      functionName,
      message,
      timestamp: Date.now(),
    });
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
