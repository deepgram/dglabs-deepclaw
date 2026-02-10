import { html, nothing } from "lit";
import type { SignalStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderSignalCard(params: { props: ChannelsProps; signal?: SignalStatus | null }) {
  const { props, signal } = params;

  return html`
    <div class="status-list">
      <div>
        <span class="label">Configured</span>
        <span>${signal?.configured ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${signal?.running ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Base URL</span>
        <span>${signal?.baseUrl ?? "n/a"}</span>
      </div>
      <div>
        <span class="label">Last start</span>
        <span>${signal?.lastStartAt ? formatRelativeTimestamp(signal.lastStartAt) : "n/a"}</span>
      </div>
      <div>
        <span class="label">Last probe</span>
        <span>${signal?.lastProbeAt ? formatRelativeTimestamp(signal.lastProbeAt) : "n/a"}</span>
      </div>
    </div>

    ${
      signal?.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
          ${signal.lastError}
        </div>`
        : nothing
    }

    ${
      signal?.probe
        ? html`<div class="callout" style="margin-top: 12px;">
          Probe ${signal.probe.ok ? "ok" : "failed"} ·
          ${signal.probe.status ?? ""} ${signal.probe.error ?? ""}
        </div>`
        : nothing
    }

    ${renderChannelConfigSection({ channelId: "signal", props })}

    <div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>
        Probe
      </button>
    </div>
  `;
}
