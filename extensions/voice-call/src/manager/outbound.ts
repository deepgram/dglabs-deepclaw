import crypto from "node:crypto";
import type { CallMode } from "../config.js";
import type { DeepgramVoiceAgentClient } from "../providers/deepgram-voice-agent.js";
import type { CallManagerContext } from "./context.js";
import { resolveNumberForAgent } from "../config.js";
import {
  TerminalStates,
  type CallId,
  type CallRecord,
  type OutboundCallOptions,
} from "../types.js";
import { mapVoiceToPolly } from "../voice-mapping.js";
import { getCallByProviderCallId } from "./lookup.js";
import { addTranscriptEntry, transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import {
  clearMaxDurationTimer,
  clearTranscriptWaiter,
  rejectTranscriptWaiter,
  waitForFinalTranscript,
} from "./timers.js";
import { generateNotifyTwiml } from "./twiml.js";

export async function initiateCall(
  ctx: CallManagerContext,
  to: string,
  sessionKey?: string,
  options?: OutboundCallOptions | string,
): Promise<{ callId: CallId; success: boolean; error?: string }> {
  const opts: OutboundCallOptions =
    typeof options === "string" ? { message: options } : (options ?? {});
  const initialMessage = opts.message;
  const mode = opts.mode ?? ctx.config.outbound.defaultMode;
  const agentId = opts.agentId;
  console.log(
    `[voice-call] Outbound call: mode=${mode}, provider=${ctx.config.provider}, to=${to}`,
  );

  if (!ctx.provider) {
    return { callId: "", success: false, error: "Provider not initialized" };
  }
  if (!ctx.webhookUrl) {
    return { callId: "", success: false, error: "Webhook URL not configured" };
  }

  if (ctx.activeCalls.size >= ctx.config.maxConcurrentCalls) {
    const now = Date.now();
    const summary = Array.from(ctx.activeCalls.values())
      .slice()
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, 3)
      .map((c) => {
        const ageSec = Math.max(0, Math.round((now - c.startedAt) / 1000));
        const provider = c.providerCallId ? ` providerCallId=${c.providerCallId}` : "";
        return `${c.callId} state=${c.state} ageSec=${ageSec}${provider}`;
      })
      .join("; ");
    return {
      callId: "",
      success: false,
      error: `Maximum concurrent calls (${ctx.config.maxConcurrentCalls}) reached${
        summary ? ` (active: ${summary})` : ""
      }`,
    };
  }

  const callId = crypto.randomUUID();
  // Resolve from number: agent-specific number > config.fromNumber > mock fallback
  const agentNumber = agentId ? resolveNumberForAgent(ctx.config, agentId, "outbound") : undefined;
  const from =
    agentNumber ||
    ctx.config.fromNumber ||
    (ctx.provider?.name === "mock" ? "+15550000000" : undefined);
  if (!from) {
    return { callId: "", success: false, error: "fromNumber not configured" };
  }

  const callRecord: CallRecord = {
    callId,
    provider: ctx.provider.name,
    direction: "outbound",
    state: "initiated",
    from,
    to,
    sessionKey,
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {
      ...(initialMessage && { initialMessage }),
      ...(agentId && { agentId }),
      mode,
    },
  };

  ctx.activeCalls.set(callId, callRecord);
  persistCallRecord(ctx.storePath, callRecord);

  try {
    // For notify mode with a message, use inline TwiML with <Say>.
    // Skip inline TwiML for Deepgram — let the stream path handle voice.
    let inlineTwiml: string | undefined;
    if (mode === "notify" && initialMessage && ctx.config.provider === "deepgram") {
      console.log(
        `[voice-call] Notify mode via Deepgram stream path (callId: ${callId}, messageChars: ${initialMessage.length})`,
      );
    }
    if (mode === "notify" && initialMessage && ctx.config.provider !== "deepgram") {
      const pollyVoice = mapVoiceToPolly(ctx.config.tts?.openai?.voice);
      inlineTwiml = generateNotifyTwiml(initialMessage, pollyVoice);
      console.log(`[voice-call] Using inline TwiML for notify mode (voice: ${pollyVoice})`);
    }

    const result = await ctx.provider.initiateCall({
      callId,
      from,
      to,
      webhookUrl: ctx.webhookUrl,
      inlineTwiml,
    });

    callRecord.providerCallId = result.providerCallId;
    ctx.providerCallIdMap.set(result.providerCallId, callId);
    persistCallRecord(ctx.storePath, callRecord);

    return { callId, success: true };
  } catch (err) {
    callRecord.state = "failed";
    callRecord.endedAt = Date.now();
    callRecord.endReason = "failed";
    persistCallRecord(ctx.storePath, callRecord);
    ctx.activeCalls.delete(callId);
    if (callRecord.providerCallId) {
      ctx.providerCallIdMap.delete(callRecord.providerCallId);
    }

    return {
      callId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function speak(
  ctx: CallManagerContext,
  callId: CallId,
  text: string,
): Promise<{ success: boolean; error?: string }> {
  const call = ctx.activeCalls.get(callId);
  if (!call) {
    return { success: false, error: "Call not found" };
  }
  if (!ctx.provider || !call.providerCallId) {
    return { success: false, error: "Call not connected" };
  }
  if (TerminalStates.has(call.state)) {
    return { success: false, error: "Call has ended" };
  }

  try {
    transitionState(call, "speaking");
    persistCallRecord(ctx.storePath, call);

    addTranscriptEntry(call, "bot", text);

    const voice = ctx.provider?.name === "twilio" ? ctx.config.tts?.openai?.voice : undefined;
    await ctx.provider.playTts({
      callId,
      providerCallId: call.providerCallId,
      text,
      voice,
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function speakInitialMessage(
  ctx: CallManagerContext,
  providerCallId: string,
): Promise<void> {
  const call = getCallByProviderCallId({
    activeCalls: ctx.activeCalls,
    providerCallIdMap: ctx.providerCallIdMap,
    providerCallId,
  });
  if (!call) {
    console.warn(`[voice-call] speakInitialMessage: no call found for ${providerCallId}`);
    return;
  }

  const initialMessage = call.metadata?.initialMessage as string | undefined;
  const mode = (call.metadata?.mode as CallMode) ?? "conversation";

  if (!initialMessage) {
    console.log(`[voice-call] speakInitialMessage: no initial message for ${call.callId}`);
    return;
  }

  // Clear so we don't speak it again if the provider reconnects.
  if (call.metadata) {
    delete call.metadata.initialMessage;
    persistCallRecord(ctx.storePath, call);
  }

  console.log(`[voice-call] Speaking initial message for call ${call.callId} (mode: ${mode})`);
  const result = await speak(ctx, call.callId, initialMessage);
  if (!result.success) {
    console.warn(`[voice-call] Failed to speak initial message: ${result.error}`);
    return;
  }

  if (mode === "notify") {
    const delaySec = ctx.config.outbound.notifyHangupDelaySec;
    console.log(`[voice-call] Notify mode: auto-hangup in ${delaySec}s for call ${call.callId}`);
    setTimeout(async () => {
      const currentCall = ctx.activeCalls.get(call.callId);
      if (currentCall && !TerminalStates.has(currentCall.state)) {
        console.log(`[voice-call] Notify mode: hanging up call ${call.callId}`);
        await endCall(ctx, call.callId);
      }
    }, delaySec * 1000);
  }
}

export async function continueCall(
  ctx: CallManagerContext,
  callId: CallId,
  prompt: string,
): Promise<{ success: boolean; transcript?: string; error?: string }> {
  const call = ctx.activeCalls.get(callId);
  if (!call) {
    return { success: false, error: "Call not found" };
  }
  if (!ctx.provider || !call.providerCallId) {
    return { success: false, error: "Call not connected" };
  }
  if (TerminalStates.has(call.state)) {
    return { success: false, error: "Call has ended" };
  }

  try {
    await speak(ctx, callId, prompt);

    transitionState(call, "listening");
    persistCallRecord(ctx.storePath, call);

    await ctx.provider.startListening({ callId, providerCallId: call.providerCallId });

    const transcript = await waitForFinalTranscript(ctx, callId);

    // Best-effort: stop listening after final transcript.
    await ctx.provider.stopListening({ callId, providerCallId: call.providerCallId });

    return { success: true, transcript };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTranscriptWaiter(ctx, callId);
  }
}

// ---------------------------------------------------------------------------
// Agent Handoff
// ---------------------------------------------------------------------------

export type HandoffParams = {
  /** Target agent's system prompt (from IDENTITY.md voice/vibe fields). */
  systemPrompt: string;
  /** Optional greeting to speak when the new agent takes over. */
  greeting?: string;
  /** Optional TTS model to switch to (e.g. different voice persona). */
  ttsModel?: string;
  /** Brief context summary for the new agent. */
  contextSummary?: string;
};

/**
 * Hand off an active call to another agent by updating the Deepgram
 * Voice Agent's system prompt and optionally switching the TTS voice.
 *
 * The call stays connected — only the agent personality changes.
 * If a greeting is provided, it is injected as an agent message so
 * the new agent introduces itself to the caller.
 */
export function handoffCall(
  ctx: CallManagerContext,
  callId: CallId,
  client: DeepgramVoiceAgentClient,
  params: HandoffParams,
): { success: boolean; error?: string } {
  const call = ctx.activeCalls.get(callId);
  if (!call) {
    return { success: false, error: "Call not found" };
  }
  if (TerminalStates.has(call.state)) {
    return { success: false, error: "Call has ended" };
  }
  if (!client.isConnected()) {
    return { success: false, error: "Voice agent not connected" };
  }

  // Build the new prompt, injecting context summary if provided.
  const prompt = params.contextSummary
    ? `${params.systemPrompt}\n\nContext from previous agent:\n${params.contextSummary}`
    : params.systemPrompt;

  // Update system prompt (switches the agent personality mid-call).
  client.updatePrompt(prompt);

  // Optionally switch TTS voice model.
  if (params.ttsModel) {
    client.updateSpeak(params.ttsModel);
  }

  // Speak greeting from the new agent so the caller hears the transition.
  if (params.greeting) {
    client.injectAgentMessage(params.greeting);
    addTranscriptEntry(call, "bot", params.greeting);
  }

  persistCallRecord(ctx.storePath, call);
  console.log(`[voice-call] Handoff completed for call ${callId}`);
  return { success: true };
}

export async function endCall(
  ctx: CallManagerContext,
  callId: CallId,
): Promise<{ success: boolean; error?: string }> {
  const call = ctx.activeCalls.get(callId);
  if (!call) {
    return { success: false, error: "Call not found" };
  }
  if (!ctx.provider || !call.providerCallId) {
    return { success: false, error: "Call not connected" };
  }
  if (TerminalStates.has(call.state)) {
    return { success: true };
  }

  try {
    await ctx.provider.hangupCall({
      callId,
      providerCallId: call.providerCallId,
      reason: "hangup-bot",
    });

    call.state = "hangup-bot";
    call.endedAt = Date.now();
    call.endReason = "hangup-bot";
    persistCallRecord(ctx.storePath, call);

    clearMaxDurationTimer(ctx, callId);
    rejectTranscriptWaiter(ctx, callId, "Call ended: hangup-bot");

    ctx.activeCalls.delete(callId);
    if (call.providerCallId) {
      ctx.providerCallIdMap.delete(call.providerCallId);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
