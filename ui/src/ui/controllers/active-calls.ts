import type { GatewayBrowserClient } from "../gateway.ts";
import type { ActiveCallEntry } from "../types.ts";

export type ActiveCallsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  activeCallCount: number;
  activeCalls: ActiveCallEntry[];
};

export async function loadActiveCalls(state: ActiveCallsState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<{ count: number; calls: ActiveCallEntry[] }>(
      "voicecall.activeCalls",
      {},
    );
    state.activeCallCount = res.count;
    state.activeCalls = res.calls;
  } catch {
    state.activeCallCount = 0;
    state.activeCalls = [];
  }
}
