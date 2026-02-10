/**
 * Deepgram Voice Agent function definitions for OpenClaw session tools.
 *
 * Maps sessions_spawn, sessions_send, and session_status to Deepgram
 * client-side function definitions so the voice agent can interact with
 * other agents and sessions during a call.
 */

import type { DeepgramFunctionDef } from "./providers/deepgram-voice-agent.js";

/**
 * Function definition for sessions_spawn — spawns a background sub-agent.
 */
export const sessionsSpawnFunction: DeepgramFunctionDef = {
  name: "sessions_spawn",
  description:
    "Spawn a background sub-agent to handle a task asynchronously. The result will be announced when ready.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The task description for the sub-agent to perform.",
      },
      label: {
        type: "string",
        description: "Optional short label for identifying this task.",
      },
      agentId: {
        type: "string",
        description: "Optional agent ID to route the task to a specific agent.",
      },
    },
    required: ["task"],
  },
};

/**
 * Function definition for sessions_send — sends a message to another session.
 */
export const sessionsSendFunction: DeepgramFunctionDef = {
  name: "sessions_send",
  description:
    "Send a message to another active session. Use sessionKey or label to identify the target.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The message to send to the target session.",
      },
      sessionKey: {
        type: "string",
        description: "The session key of the target session.",
      },
      label: {
        type: "string",
        description: "The label of the target session (alternative to sessionKey).",
      },
    },
    required: ["message"],
  },
};

/**
 * Function definition for session_status — queries session status.
 */
export const sessionStatusFunction: DeepgramFunctionDef = {
  name: "session_status",
  description:
    "Show session status including model, usage, and cost. Optionally change the model override.",
  parameters: {
    type: "object",
    properties: {
      sessionKey: {
        type: "string",
        description: "Optional session key to query (defaults to current session).",
      },
      model: {
        type: "string",
        description: 'Optional model override to set (use "default" to reset).',
      },
    },
  },
};

/**
 * Function definition for voice_handoff — transfers a call to another agent.
 */
export const voiceHandoffFunction: DeepgramFunctionDef = {
  name: "voice_handoff",
  description:
    "Transfer the current call to another agent. Use when the caller needs a different department or specialist.",
  parameters: {
    type: "object",
    properties: {
      targetAgentId: {
        type: "string",
        description: "The agent ID to hand the call off to (e.g. 'billing', 'support').",
      },
      contextSummary: {
        type: "string",
        description: "Brief summary of the conversation so far for the receiving agent.",
      },
    },
    required: ["targetAgentId"],
  },
};

/**
 * Returns the set of Deepgram function definitions for inter-agent
 * communication tools available to voice sessions.
 */
export function buildVoiceAgentFunctions(): DeepgramFunctionDef[] {
  return [sessionsSpawnFunction, sessionsSendFunction, sessionStatusFunction, voiceHandoffFunction];
}
