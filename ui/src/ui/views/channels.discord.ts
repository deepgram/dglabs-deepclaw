import { html, nothing } from "lit";
import type { DiscordStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderDiscordCard(params: {
  props: ChannelsProps;
  discord?: DiscordStatus | null;
}) {
  const { props, discord } = params;

  return html`
    <div class="status-list">
      <div>
        <span class="label">Configured</span>
        <span>${discord?.configured ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${discord?.running ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Last start</span>
        <span>${discord?.lastStartAt ? formatRelativeTimestamp(discord.lastStartAt) : "n/a"}</span>
      </div>
      <div>
        <span class="label">Last probe</span>
        <span>${discord?.lastProbeAt ? formatRelativeTimestamp(discord.lastProbeAt) : "n/a"}</span>
      </div>
    </div>

    ${
      discord?.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
          ${discord.lastError}
        </div>`
        : nothing
    }

    ${
      discord?.probe
        ? html`<div class="callout" style="margin-top: 12px;">
          Probe ${discord.probe.ok ? "ok" : "failed"} ·
          ${discord.probe.status ?? ""} ${discord.probe.error ?? ""}
        </div>`
        : nothing
    }

    ${renderChannelConfigSection({ channelId: "discord", props })}

    <div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>
        Probe
      </button>
    </div>
  `;
}
