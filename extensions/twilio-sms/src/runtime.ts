import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setTwilioSmsRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getTwilioSmsRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Twilio SMS runtime not initialized");
  }
  return runtime;
}
