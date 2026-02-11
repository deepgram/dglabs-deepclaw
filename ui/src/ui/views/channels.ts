import { html, nothing } from "lit";
import type {
  ChannelAccountSnapshot,
  ChannelUiMetaEntry,
  ChannelsStatusSnapshot,
  DiscordStatus,
  GoogleChatStatus,
  IMessageStatus,
  NostrProfile,
  NostrStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  VoiceCallStatus,
  WhatsAppStatus,
} from "../types.ts";
import type { ChannelKey, ChannelsChannelData, ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { renderDiscordCard } from "./channels.discord.ts";
import { renderGoogleChatCard } from "./channels.googlechat.ts";
import { renderIMessageCard } from "./channels.imessage.ts";
import { renderNostrCard } from "./channels.nostr.ts";
import {
  channelEnabled,
  channelHasError,
  deriveChannelStatusLevel,
  getChannelAccountCount,
} from "./channels.shared.ts";
import { renderSignalCard } from "./channels.signal.ts";
import { renderSlackCard } from "./channels.slack.ts";
import { renderTelegramCard } from "./channels.telegram.ts";
import { renderVoiceCallCard } from "./channels.voicecall.ts";
import { renderWhatsAppCard } from "./channels.whatsapp.ts";

export function renderChannels(props: ChannelsProps) {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  const whatsapp = (channels?.whatsapp ?? undefined) as WhatsAppStatus | undefined;
  const telegram = (channels?.telegram ?? undefined) as TelegramStatus | undefined;
  const discord = (channels?.discord ?? null) as DiscordStatus | null;
  const googlechat = (channels?.googlechat ?? null) as GoogleChatStatus | null;
  const slack = (channels?.slack ?? null) as SlackStatus | null;
  const signal = (channels?.signal ?? null) as SignalStatus | null;
  const imessage = (channels?.imessage ?? null) as IMessageStatus | null;
  const nostr = (channels?.nostr ?? null) as NostrStatus | null;
  const voicecall = (channels?.voicecall ?? null) as VoiceCallStatus | null;
  const channelOrder = resolveChannelOrder(props.snapshot);
  const orderedChannels = channelOrder
    .map((key, index) => ({
      key,
      enabled: channelEnabled(key, props),
      order: index,
    }))
    .toSorted((a, b) => {
      if (a.enabled !== b.enabled) {
        return a.enabled ? -1 : 1;
      }
      return a.order - b.order;
    });

  const channelData: ChannelsChannelData = {
    whatsapp,
    telegram,
    discord,
    googlechat,
    slack,
    signal,
    imessage,
    nostr,
    voicecall,
    channelAccounts: props.snapshot?.channelAccounts ?? null,
  };

  return html`
    <section class="channel-list">
      ${orderedChannels.map((channel) => {
        const hasError = channelHasError(channel.key, props);
        const statusLevel = deriveChannelStatusLevel(channel.key, props);
        const label = resolveChannelLabel(props.snapshot, channel.key);
        const accountCount = getChannelAccountCount(channel.key, props.snapshot?.channelAccounts);
        const dotClass = statusLevel === "error" ? "" : statusLevel;

        return html`
          <details class="channel-row ${hasError ? "channel-row--error" : ""}" ?open=${hasError}>
            <summary class="channel-summary">
              <span class="channel-summary__dot">
                <span class="statusDot ${dotClass}"></span>
              </span>
              <span class="channel-summary__name">${label}</span>
              <span class="channel-summary__chips">
                ${
                  channel.enabled
                    ? html`
                        <span class="chip chip-ok">Active</span>
                      `
                    : html`
                        <span class="chip">Inactive</span>
                      `
                }
                ${
                  hasError
                    ? html`
                        <span class="chip chip-danger">Error</span>
                      `
                    : nothing
                }
                ${accountCount >= 2 ? html`<span class="chip">${accountCount} accounts</span>` : nothing}
                ${
                  channel.key === "voicecall" && channel.enabled && voicecall
                    ? html`
                      ${
                        voicecall.inboundEnabled
                          ? html`
                              <span class="chip chip-ok">Inbound</span>
                            `
                          : nothing
                      }
                      <span class="chip chip-ok">Outbound</span>
                    `
                    : nothing
                }
              </span>
              <span class="channel-summary__chevron">▸</span>
            </summary>
            <div class="channel-detail">
              ${renderChannel(channel.key, props, channelData)}
            </div>
          </details>
        `;
      })}
    </section>

    <details class="channel-debug-toggle">
      <summary>Channel health snapshot${props.lastSuccessAt ? html` · ${formatRelativeTimestamp(props.lastSuccessAt)}` : nothing}</summary>
      ${
        props.lastError
          ? html`<div class="callout danger" style="margin: 12px;">
            ${props.lastError}
          </div>`
          : nothing
      }
      <pre class="code-block">
${props.snapshot ? JSON.stringify(props.snapshot, null, 2) : "No snapshot yet."}
      </pre>
    </details>
  `;
}

function resolveChannelOrder(snapshot: ChannelsStatusSnapshot | null): ChannelKey[] {
  if (snapshot?.channelMeta?.length) {
    return snapshot.channelMeta.map((entry) => entry.id);
  }
  if (snapshot?.channelOrder?.length) {
    return snapshot.channelOrder;
  }
  return ["whatsapp", "telegram", "discord", "googlechat", "slack", "signal", "imessage", "nostr"];
}

function renderChannel(key: ChannelKey, props: ChannelsProps, data: ChannelsChannelData) {
  switch (key) {
    case "whatsapp":
      return renderWhatsAppCard({
        props,
        whatsapp: data.whatsapp,
      });
    case "telegram":
      return renderTelegramCard({
        props,
        telegram: data.telegram,
        telegramAccounts: data.channelAccounts?.telegram ?? [],
      });
    case "discord":
      return renderDiscordCard({
        props,
        discord: data.discord,
      });
    case "googlechat":
      return renderGoogleChatCard({
        props,
        googleChat: data.googlechat,
      });
    case "slack":
      return renderSlackCard({
        props,
        slack: data.slack,
      });
    case "signal":
      return renderSignalCard({
        props,
        signal: data.signal,
      });
    case "imessage":
      return renderIMessageCard({
        props,
        imessage: data.imessage,
      });
    case "voicecall":
      return renderVoiceCallCard({
        props,
        voicecall: data.voicecall,
      });
    case "nostr": {
      const nostrAccounts = data.channelAccounts?.nostr ?? [];
      const primaryAccount = nostrAccounts[0];
      const accountId = primaryAccount?.accountId ?? "default";
      const profile =
        (primaryAccount as { profile?: NostrProfile | null } | undefined)?.profile ?? null;
      const showForm =
        props.nostrProfileAccountId === accountId ? props.nostrProfileFormState : null;
      const profileFormCallbacks = showForm
        ? {
            onFieldChange: props.onNostrProfileFieldChange,
            onSave: props.onNostrProfileSave,
            onImport: props.onNostrProfileImport,
            onCancel: props.onNostrProfileCancel,
            onToggleAdvanced: props.onNostrProfileToggleAdvanced,
          }
        : null;
      return renderNostrCard({
        props,
        nostr: data.nostr,
        nostrAccounts,
        profileFormState: showForm,
        profileFormCallbacks,
        onEditProfile: () => props.onNostrProfileEdit(accountId, profile),
      });
    }
    default:
      return renderGenericChannelCard(key, props, data.channelAccounts ?? {});
  }
}

function renderGenericChannelCard(
  key: ChannelKey,
  props: ChannelsProps,
  channelAccounts: Record<string, ChannelAccountSnapshot[]>,
) {
  const status = props.snapshot?.channels?.[key] as Record<string, unknown> | undefined;
  const configured = typeof status?.configured === "boolean" ? status.configured : undefined;
  const running = typeof status?.running === "boolean" ? status.running : undefined;
  const connected = typeof status?.connected === "boolean" ? status.connected : undefined;
  const lastError = typeof status?.lastError === "string" ? status.lastError : undefined;
  const accounts = channelAccounts[key] ?? [];

  return html`
    ${
      accounts.length > 0
        ? html`
          <div class="account-card-list">
            ${accounts.map((account) => renderGenericAccount(account))}
          </div>
        `
        : html`
          <div class="status-list">
            <div>
              <span class="label">Configured</span>
              <span>${configured == null ? "n/a" : configured ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Running</span>
              <span>${running == null ? "n/a" : running ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Connected</span>
              <span>${connected == null ? "n/a" : connected ? "Yes" : "No"}</span>
            </div>
          </div>
        `
    }

    ${
      lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
          ${lastError}
        </div>`
        : nothing
    }

    ${renderChannelConfigSection({ channelId: key, props })}
  `;
}

function resolveChannelMetaMap(
  snapshot: ChannelsStatusSnapshot | null,
): Record<string, ChannelUiMetaEntry> {
  if (!snapshot?.channelMeta?.length) {
    return {};
  }
  return Object.fromEntries(snapshot.channelMeta.map((entry) => [entry.id, entry]));
}

function resolveChannelLabel(snapshot: ChannelsStatusSnapshot | null, key: string): string {
  const meta = resolveChannelMetaMap(snapshot)[key];
  if (meta?.label) {
    return meta.label;
  }
  if (snapshot?.channelLabels?.[key]) {
    return snapshot.channelLabels[key];
  }
  // Capitalize the key nicely for display
  const labels: Record<string, string> = {
    whatsapp: "WhatsApp",
    telegram: "Telegram",
    discord: "Discord",
    googlechat: "Google Chat",
    slack: "Slack",
    signal: "Signal",
    imessage: "iMessage",
    nostr: "Nostr",
  };
  return labels[key] ?? key;
}

const RECENT_ACTIVITY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function hasRecentActivity(account: ChannelAccountSnapshot): boolean {
  if (!account.lastInboundAt) {
    return false;
  }
  return Date.now() - account.lastInboundAt < RECENT_ACTIVITY_THRESHOLD_MS;
}

function deriveRunningStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" {
  if (account.running) {
    return "Yes";
  }
  // If we have recent inbound activity, the channel is effectively running
  if (hasRecentActivity(account)) {
    return "Active";
  }
  return "No";
}

function deriveConnectedStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" | "n/a" {
  if (account.connected === true) {
    return "Yes";
  }
  if (account.connected === false) {
    return "No";
  }
  // If connected is null/undefined but we have recent activity, show as active
  if (hasRecentActivity(account)) {
    return "Active";
  }
  return "n/a";
}

function renderGenericAccount(account: ChannelAccountSnapshot) {
  const runningStatus = deriveRunningStatus(account);
  const connectedStatus = deriveConnectedStatus(account);

  return html`
    <div class="account-card">
      <div class="account-card-header">
        <div class="account-card-title">${account.name || account.accountId}</div>
        <div class="account-card-id">${account.accountId}</div>
      </div>
      <div class="status-list account-card-status">
        <div>
          <span class="label">Running</span>
          <span>${runningStatus}</span>
        </div>
        <div>
          <span class="label">Configured</span>
          <span>${account.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Connected</span>
          <span>${connectedStatus}</span>
        </div>
        <div>
          <span class="label">Last inbound</span>
          <span>${account.lastInboundAt ? formatRelativeTimestamp(account.lastInboundAt) : "n/a"}</span>
        </div>
        ${
          account.lastError
            ? html`
              <div class="account-card-error">
                ${account.lastError}
              </div>
            `
            : nothing
        }
      </div>
    </div>
  `;
}
