import { describe, expect, it } from "vitest";
import {
  buildVoiceAgentFunctions,
  sessionsSpawnFunction,
  sessionsSendFunction,
  sessionStatusFunction,
  voiceHandoffFunction,
} from "./voice-functions.js";

describe("voice function definitions", () => {
  it("buildVoiceAgentFunctions returns all four functions", () => {
    const fns = buildVoiceAgentFunctions();

    expect(fns).toHaveLength(4);
    const names = fns.map((f) => f.name);
    expect(names).toContain("sessions_spawn");
    expect(names).toContain("sessions_send");
    expect(names).toContain("session_status");
    expect(names).toContain("voice_handoff");
  });

  it("sessions_spawn has required 'task' parameter", () => {
    expect(sessionsSpawnFunction.name).toBe("sessions_spawn");
    expect(sessionsSpawnFunction.parameters.required).toContain("task");
    expect(sessionsSpawnFunction.parameters.properties.task).toBeDefined();
    expect(sessionsSpawnFunction.parameters.properties.task.type).toBe("string");
  });

  it("sessions_send has required 'message' parameter", () => {
    expect(sessionsSendFunction.name).toBe("sessions_send");
    expect(sessionsSendFunction.parameters.required).toContain("message");
    expect(sessionsSendFunction.parameters.properties.message).toBeDefined();
    expect(sessionsSendFunction.parameters.properties.sessionKey).toBeDefined();
  });

  it("session_status has optional parameters only", () => {
    expect(sessionStatusFunction.name).toBe("session_status");
    expect(sessionStatusFunction.parameters.required).toBeUndefined();
    expect(sessionStatusFunction.parameters.properties.sessionKey).toBeDefined();
    expect(sessionStatusFunction.parameters.properties.model).toBeDefined();
  });

  it("voice_handoff has required 'targetAgentId' parameter", () => {
    expect(voiceHandoffFunction.name).toBe("voice_handoff");
    expect(voiceHandoffFunction.parameters.required).toContain("targetAgentId");
    expect(voiceHandoffFunction.parameters.properties.targetAgentId).toBeDefined();
    expect(voiceHandoffFunction.parameters.properties.contextSummary).toBeDefined();
  });

  it("all functions have descriptions", () => {
    const fns = buildVoiceAgentFunctions();
    for (const fn of fns) {
      expect(fn.description).toBeTruthy();
      expect(fn.description.length).toBeGreaterThan(10);
    }
  });

  it("all functions have object parameter type", () => {
    const fns = buildVoiceAgentFunctions();
    for (const fn of fns) {
      expect(fn.parameters.type).toBe("object");
    }
  });
});
