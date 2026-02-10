/**
 * Voice Session Bridge
 *
 * Maintains a registry of active voice sessions so that subagent results
 * and inter-agent messages can be injected into live Deepgram Voice Agent
 * conversations via `InjectAgentMessage`.
 *
 * Text agents can send messages to voice sessions using `sessions_send`
 * with the standard session key (e.g. `agent:main:voice-call:<to>:<from>`).
 * The gateway will route the message to the embedded Pi agent, which will
 * produce a response. This bridge allows that response to be spoken aloud
 * by injecting it into the active Deepgram connection.
 */

import type { DeepgramVoiceAgentClient } from "./providers/deepgram-voice-agent.js";

type VoiceSessionEntry = {
  client: DeepgramVoiceAgentClient;
  callId: string;
  registeredAt: number;
};

const activeVoiceSessions = new Map<string, VoiceSessionEntry>();

/**
 * Register a live voice session so external messages can be injected.
 *
 * @param sessionKey - The canonical session key (e.g. `agent:main:voice-call:1234:5678`)
 * @param client - The active DeepgramVoiceAgentClient for this session
 * @param callId - The call ID associated with this session
 */
export function registerVoiceSession(
  sessionKey: string,
  client: DeepgramVoiceAgentClient,
  callId: string,
): void {
  activeVoiceSessions.set(sessionKey, {
    client,
    callId,
    registeredAt: Date.now(),
  });
}

/**
 * Unregister a voice session (call ended or client disconnected).
 */
export function unregisterVoiceSession(sessionKey: string): void {
  activeVoiceSessions.delete(sessionKey);
}

/**
 * Inject a message into an active voice session.
 *
 * Used by subagent announce flows and inter-agent sends to speak results
 * to the caller. Returns true if the message was injected, false if no
 * active voice session was found.
 */
export function injectMessageToVoiceSession(sessionKey: string, message: string): boolean {
  const entry = activeVoiceSessions.get(sessionKey);
  if (!entry || !entry.client.isConnected()) {
    return false;
  }
  entry.client.injectAgentMessage(message);
  return true;
}

/**
 * Check whether a session key corresponds to an active voice session.
 */
export function isActiveVoiceSession(sessionKey: string): boolean {
  const entry = activeVoiceSessions.get(sessionKey);
  return !!entry && entry.client.isConnected();
}

/**
 * Get all currently active voice session keys.
 */
export function getActiveVoiceSessionKeys(): string[] {
  return Array.from(activeVoiceSessions.keys());
}
