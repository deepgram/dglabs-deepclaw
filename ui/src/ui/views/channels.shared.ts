import { html, nothing } from "lit";
import type { ChannelAccountSnapshot } from "../types.ts";
import type { ChannelKey, ChannelsProps } from "./channels.types.ts";

export function channelEnabled(key: ChannelKey, props: ChannelsProps) {
  const snapshot = props.snapshot;
  const channels = snapshot?.channels as Record<string, unknown> | null;
  if (!snapshot || !channels) {
    return false;
  }
  const channelStatus = channels[key] as Record<string, unknown> | undefined;
  const configured = typeof channelStatus?.configured === "boolean" && channelStatus.configured;
  const running = typeof channelStatus?.running === "boolean" && channelStatus.running;
  const connected = typeof channelStatus?.connected === "boolean" && channelStatus.connected;
  const accounts = snapshot.channelAccounts?.[key] ?? [];
  const accountActive = accounts.some(
    (account) => account.configured || account.running || account.connected,
  );
  return configured || running || connected || accountActive;
}

export function getChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
): number {
  return channelAccounts?.[key]?.length ?? 0;
}

export function renderChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
) {
  const count = getChannelAccountCount(key, channelAccounts);
  if (count < 2) {
    return nothing;
  }
  return html`<div class="account-count">Accounts (${count})</div>`;
}

/**
 * Check if a channel has any error (top-level or account-level).
 */
export function channelHasError(key: ChannelKey, props: ChannelsProps): boolean {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  const status = channels?.[key] as Record<string, unknown> | undefined;
  if (typeof status?.lastError === "string" && status.lastError) {
    return true;
  }
  const accounts = props.snapshot?.channelAccounts?.[key] ?? [];
  return accounts.some((account) => !!account.lastError);
}

/**
 * Derive the status level for the summary row dot.
 */
export function deriveChannelStatusLevel(
  key: ChannelKey,
  props: ChannelsProps,
): "ok" | "warn" | "error" | "off" {
  if (channelHasError(key, props)) {
    return "error";
  }
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  const status = channels?.[key] as Record<string, unknown> | undefined;
  const configured = typeof status?.configured === "boolean" && status.configured;
  const running = typeof status?.running === "boolean" && status.running;
  const connected = typeof status?.connected === "boolean" && status.connected;

  // Also check account-level status
  const accounts = props.snapshot?.channelAccounts?.[key] ?? [];
  const anyAccountRunning = accounts.some((a) => a.running);
  const anyAccountConfigured = accounts.some((a) => a.configured);

  if (running || connected || anyAccountRunning) {
    return "ok";
  }
  if (configured || anyAccountConfigured) {
    return "warn";
  }
  return "off";
}
