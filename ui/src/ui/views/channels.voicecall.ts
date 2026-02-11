import { html, nothing } from "lit";
import type { VoiceCallStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderVoiceCallCard(params: {
  props: ChannelsProps;
  voicecall: VoiceCallStatus | null | undefined;
}) {
  const { props, voicecall } = params;

  if (!voicecall) {
    return html`
      <div class="status-list">
        <div>
          <span class="label">Status</span>
          <span>Not configured</span>
        </div>
      </div>
      ${renderChannelConfigSection({ channelId: "voicecall", props })}
    `;
  }

  const numbers = voicecall.numbers ?? [];

  return html`
    <div class="row" style="gap: 6px; margin-bottom: 12px;">
      ${
        voicecall.inboundEnabled
          ? html`
              <span class="chip chip-ok">Inbound</span>
            `
          : nothing
      }
      <span class="chip chip-ok">Outbound</span>
    </div>

    <div class="status-list">
      <div>
        <span class="label">Provider</span>
        <span>${voicecall.provider ?? "n/a"}</span>
      </div>
      <div>
        <span class="label">From Number</span>
        <span>${voicecall.fromNumber ?? "n/a"}</span>
      </div>
      <div>
        <span class="label">Inbound Policy</span>
        <span>${voicecall.inboundPolicy}</span>
      </div>
      <div>
        <span class="label">Outbound Mode</span>
        <span>${voicecall.outboundMode}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${voicecall.running ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Active Calls</span>
        <span>${voicecall.activeCalls}</span>
      </div>
      <div>
        <span class="label">Default Agent</span>
        <span>${voicecall.defaultAgentId}</span>
      </div>
    </div>

    ${
      voicecall.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
          ${voicecall.lastError}
        </div>`
        : nothing
    }

    ${
      numbers.length > 0
        ? html`
          <div style="margin-top: 16px;">
            <div class="label" style="margin-bottom: 8px;">Number Routing</div>
            <table class="status-table" style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr>
                  <th style="text-align: left; padding: 4px 8px;">Number</th>
                  <th style="text-align: left; padding: 4px 8px;">Agent</th>
                  <th style="text-align: left; padding: 4px 8px;">Direction</th>
                </tr>
              </thead>
              <tbody>
                ${numbers.map(
                  (entry) => html`
                    <tr>
                      <td style="padding: 4px 8px;">${entry.number}</td>
                      <td style="padding: 4px 8px;">${entry.agentId}</td>
                      <td style="padding: 4px 8px;">
                        ${
                          entry.direction === "both" || entry.direction === "inbound"
                            ? html`
                                <span class="chip chip-ok" style="font-size: 0.75em">In</span>
                              `
                            : nothing
                        }
                        ${
                          entry.direction === "both" || entry.direction === "outbound"
                            ? html`
                                <span class="chip chip-ok" style="font-size: 0.75em">Out</span>
                              `
                            : nothing
                        }
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
        : nothing
    }

    ${renderChannelConfigSection({ channelId: "voicecall", props })}
  `;
}
