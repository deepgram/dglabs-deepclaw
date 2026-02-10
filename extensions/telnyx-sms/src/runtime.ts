import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setTelnyxSmsRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getTelnyxSmsRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Telnyx SMS runtime not initialized");
  }
  return runtime;
}
