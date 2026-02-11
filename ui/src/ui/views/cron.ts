import { html, nothing } from "lit";
import type { ChannelUiMetaEntry, CronJob, CronRunLogEntry, CronStatus } from "../types.ts";
import type { CronFormState } from "../ui-types.ts";
import { formatRelativeTimestamp, formatDurationHuman, formatMs } from "../format.ts";
import { pathForTab } from "../navigation.ts";
import { formatCronSchedule, formatNextRun } from "../presenter.ts";

export type CronProps = {
  basePath: string;
  loading: boolean;
  status: CronStatus | null;
  jobs: CronJob[];
  error: string | null;
  busy: boolean;
  form: CronFormState;
  channels: string[];
  channelLabels?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  runsJobId: string | null;
  runs: CronRunLogEntry[];
  editingJobId: string | null;
  formOpen: boolean;
  onFormChange: (patch: Partial<CronFormState>) => void;
  onRefresh: () => void;
  onNewJob: () => void;
  onAdd: () => void;
  onSave: () => void;
  onEdit: (job: CronJob) => void;
  onCancelEdit: () => void;
  onToggle: (job: CronJob, enabled: boolean) => void;
  onRun: (job: CronJob) => void;
  onRemove: (job: CronJob) => void;
  onLoadRuns: (jobId: string) => void;
};

/* ── Human-friendly chip labels (Step 7) ── */

const HUMAN_LABELS: Record<string, string> = {
  main: "Main session",
  isolated: "Isolated",
  now: "Immediate",
  "next-heartbeat": "Next heartbeat",
  systemEvent: "System event",
  agentTurn: "Agent prompt",
  announce: "Announce",
  none: "Silent",
};

function humanLabel(value: string): string {
  return HUMAN_LABELS[value] ?? value;
}

/* ── Helpers ── */

function buildChannelOptions(props: CronProps): string[] {
  const options = ["last", ...props.channels.filter(Boolean)];
  const current = props.form.deliveryChannel?.trim();
  if (current && !options.includes(current)) {
    options.push(current);
  }
  const seen = new Set<string>();
  return options.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function resolveChannelLabel(props: CronProps, channel: string): string {
  if (channel === "last") {
    return "last";
  }
  const meta = props.channelMeta?.find((entry) => entry.id === channel);
  if (meta?.label) {
    return meta.label;
  }
  return props.channelLabels?.[channel] ?? channel;
}

/** Check whether any advanced field has a non-default value. */
function hasAdvancedValues(form: CronFormState): boolean {
  return !!(
    form.description.trim() ||
    form.agentId.trim() ||
    !form.enabled ||
    form.sessionTarget !== "isolated" ||
    form.wakeMode !== "now" ||
    (form.payloadKind === "agentTurn" &&
      (form.deliveryMode !== "announce" ||
        (form.deliveryChannel && form.deliveryChannel !== "last") ||
        form.deliveryTo.trim() ||
        form.timeoutSeconds.trim()))
  );
}

/* ── Main render ── */

export function renderCron(props: CronProps) {
  const isEditing = props.editingJobId != null;
  const showForm = props.formOpen || isEditing;
  return html`
    ${renderStatusBar(props)}

    ${
      showForm
        ? html`
            <div class="card" style="margin-top: 18px;">
              <div class="card-title">${isEditing ? "Edit Job" : "New Job"}</div>
              <div class="card-sub">
                ${isEditing ? "Update the selected cron job." : "Create a scheduled wakeup or agent run."}
              </div>
              ${renderForm(props, isEditing)}
            </div>
          `
        : nothing
    }

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Jobs</div>
      <div class="card-sub">All scheduled jobs stored in the gateway.</div>
      ${
        props.jobs.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No jobs yet.</div>
            `
          : html`
            <div class="list" style="margin-top: 12px;">
              ${props.jobs.map((job) => renderJob(job, props))}
            </div>
          `
      }
    </section>
  `;
}

/* ── Step 3: Compact status bar ── */

function renderStatusBar(props: CronProps) {
  const enabled = props.status?.enabled;
  const statusText = enabled == null ? "n/a" : enabled ? "Active" : "Inactive";
  const statusClass = enabled == null ? "" : enabled ? "chip-ok" : "chip-danger";
  const jobCount = props.status?.jobs ?? "–";
  const nextWake = formatNextRun(props.status?.nextWakeAtMs ?? null);
  return html`
    <div class="cron-status-bar">
      <span class="cron-status-bar__item">
        Scheduler: <span class=${`chip ${statusClass}`} style="margin-left: 4px;">${statusText}</span>
      </span>
      <span class="cron-status-bar__sep"></span>
      <span class="cron-status-bar__item">${jobCount} jobs</span>
      <span class="cron-status-bar__sep"></span>
      <span class="cron-status-bar__item">Next: ${nextWake}</span>
      <span class="cron-status-bar__spacer"></span>
      ${props.error ? html`<span class="muted" style="font-size: 12px;">${props.error}</span>` : nothing}
      <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
        ${props.loading ? "Refreshing…" : "Refresh"}
      </button>
      ${
        !props.formOpen && !props.editingJobId
          ? html`<button class="btn btn--sm primary" @click=${props.onNewJob}>New Job</button>`
          : nothing
      }
    </div>
  `;
}

/* ── Step 4: Progressive disclosure form ── */

function renderForm(props: CronProps, isEditing: boolean) {
  const channelOptions = buildChannelOptions(props);
  const advancedOpen = isEditing && hasAdvancedValues(props.form);
  return html`
    <div class="form-grid" style="margin-top: 16px;">
      <label class="field">
        <span>Name</span>
        <input
          .value=${props.form.name}
          @input=${(e: Event) => props.onFormChange({ name: (e.target as HTMLInputElement).value })}
        />
      </label>
      <label class="field">
        <span>Schedule</span>
        <select
          .value=${props.form.scheduleKind}
          @change=${(e: Event) =>
            props.onFormChange({
              scheduleKind: (e.target as HTMLSelectElement).value as CronFormState["scheduleKind"],
            })}
        >
          <option value="every">Every</option>
          <option value="at">At</option>
          <option value="cron">Cron</option>
        </select>
      </label>
    </div>
    ${renderScheduleFields(props)}
    <div class="form-grid" style="margin-top: 12px;">
      <label class="field">
        <span>Payload</span>
        <select
          .value=${props.form.payloadKind}
          @change=${(e: Event) =>
            props.onFormChange({
              payloadKind: (e.target as HTMLSelectElement).value as CronFormState["payloadKind"],
            })}
        >
          <option value="systemEvent">System event</option>
          <option value="agentTurn">Agent turn</option>
        </select>
      </label>
    </div>
    <label class="field" style="margin-top: 12px;">
      <span>${props.form.payloadKind === "systemEvent" ? "System text" : "Agent message"}</span>
      <textarea
        .value=${props.form.payloadText}
        @input=${(e: Event) =>
          props.onFormChange({
            payloadText: (e.target as HTMLTextAreaElement).value,
          })}
        rows="4"
      ></textarea>
    </label>

    <details class="cron-form-advanced" ?open=${advancedOpen}>
      <summary class="cron-form-advanced__header">
        <span class="cron-form-advanced__chevron">▸</span>
        Advanced
      </summary>
      <div class="cron-form-advanced__content">
        <label class="field">
          <span>Description</span>
          <input
            .value=${props.form.description}
            @input=${(e: Event) =>
              props.onFormChange({ description: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label class="field">
          <span>Agent ID</span>
          <input
            .value=${props.form.agentId}
            @input=${(e: Event) =>
              props.onFormChange({ agentId: (e.target as HTMLInputElement).value })}
            placeholder="default"
          />
        </label>
        <label class="field checkbox">
          <span>Enabled</span>
          <input
            type="checkbox"
            .checked=${props.form.enabled}
            @change=${(e: Event) =>
              props.onFormChange({ enabled: (e.target as HTMLInputElement).checked })}
          />
        </label>
        <div class="form-grid">
          <label class="field">
            <span>Session</span>
            <select
              .value=${props.form.sessionTarget}
              @change=${(e: Event) =>
                props.onFormChange({
                  sessionTarget: (e.target as HTMLSelectElement)
                    .value as CronFormState["sessionTarget"],
                })}
            >
              <option value="main">Main</option>
              <option value="isolated">Isolated</option>
            </select>
          </label>
          <label class="field">
            <span>Wake mode</span>
            <select
              .value=${props.form.wakeMode}
              @change=${(e: Event) =>
                props.onFormChange({
                  wakeMode: (e.target as HTMLSelectElement).value as CronFormState["wakeMode"],
                })}
            >
              <option value="now">Now</option>
              <option value="next-heartbeat">Next heartbeat</option>
            </select>
          </label>
        </div>
        ${
          props.form.payloadKind === "agentTurn"
            ? html`
                <div class="form-grid">
                  <label class="field">
                    <span>Delivery</span>
                    <select
                      .value=${props.form.deliveryMode}
                      @change=${(e: Event) =>
                        props.onFormChange({
                          deliveryMode: (e.target as HTMLSelectElement)
                            .value as CronFormState["deliveryMode"],
                        })}
                    >
                      <option value="announce">Announce summary (default)</option>
                      <option value="none">None (internal)</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Timeout (seconds)</span>
                    <input
                      .value=${props.form.timeoutSeconds}
                      @input=${(e: Event) =>
                        props.onFormChange({
                          timeoutSeconds: (e.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  ${
                    props.form.deliveryMode === "announce"
                      ? html`
                          <label class="field">
                            <span>Channel</span>
                            <select
                              .value=${props.form.deliveryChannel || "last"}
                              @change=${(e: Event) =>
                                props.onFormChange({
                                  deliveryChannel: (e.target as HTMLSelectElement).value,
                                })}
                            >
                              ${channelOptions.map(
                                (channel) =>
                                  html`<option value=${channel}>
                                    ${resolveChannelLabel(props, channel)}
                                  </option>`,
                              )}
                            </select>
                          </label>
                          <label class="field">
                            <span>To</span>
                            <input
                              .value=${props.form.deliveryTo}
                              @input=${(e: Event) =>
                                props.onFormChange({
                                  deliveryTo: (e.target as HTMLInputElement).value,
                                })}
                              placeholder="+1555… or chat id"
                            />
                          </label>
                        `
                      : nothing
                  }
                </div>
              `
            : nothing
        }
      </div>
    </details>

    <div class="row" style="margin-top: 14px; gap: 8px;">
      ${
        isEditing
          ? html`
              <button class="btn primary" ?disabled=${props.busy} @click=${props.onSave}>
                ${props.busy ? "Saving…" : "Save"}
              </button>
              <button class="btn" @click=${props.onCancelEdit}>Cancel</button>
            `
          : html`
              <button class="btn primary" ?disabled=${props.busy} @click=${props.onAdd}>
                ${props.busy ? "Saving…" : "Add job"}
              </button>
            `
      }
    </div>
  `;
}

function renderScheduleFields(props: CronProps) {
  const form = props.form;
  if (form.scheduleKind === "at") {
    return html`
      <label class="field" style="margin-top: 12px;">
        <span>Run at</span>
        <input
          type="datetime-local"
          .value=${form.scheduleAt}
          @input=${(e: Event) =>
            props.onFormChange({
              scheduleAt: (e.target as HTMLInputElement).value,
            })}
        />
      </label>
    `;
  }
  if (form.scheduleKind === "every") {
    return html`
      <div class="form-grid" style="margin-top: 12px;">
        <label class="field">
          <span>Every</span>
          <input
            .value=${form.everyAmount}
            @input=${(e: Event) =>
              props.onFormChange({
                everyAmount: (e.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label class="field">
          <span>Unit</span>
          <select
            .value=${form.everyUnit}
            @change=${(e: Event) =>
              props.onFormChange({
                everyUnit: (e.target as HTMLSelectElement).value as CronFormState["everyUnit"],
              })}
          >
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </select>
        </label>
      </div>
    `;
  }
  return html`
    <div class="form-grid" style="margin-top: 12px;">
      <label class="field">
        <span>Expression</span>
        <input
          .value=${form.cronExpr}
          @input=${(e: Event) =>
            props.onFormChange({ cronExpr: (e.target as HTMLInputElement).value })}
        />
      </label>
      <label class="field">
        <span>Timezone (optional)</span>
        <input
          .value=${form.cronTz}
          @input=${(e: Event) =>
            props.onFormChange({ cronTz: (e.target as HTMLInputElement).value })}
        />
      </label>
    </div>
  `;
}

/* ── Step 6: Job card with edit button + inline runs ── */

function renderJob(job: CronJob, props: CronProps) {
  const isSelected = props.runsJobId === job.id;
  const isEditTarget = props.editingJobId === job.id;
  const orderedRuns = isSelected ? props.runs.toSorted((a, b) => b.ts - a.ts) : [];
  const itemClass = [
    "list-item list-item-clickable cron-job",
    isSelected ? "list-item-selected" : "",
    isEditTarget ? "cron-job-editing" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${itemClass} @click=${() => props.onLoadRuns(job.id)}>
      <div class="list-main">
        <div class="list-title">${job.name}</div>
        <div class="list-sub">${formatCronSchedule(job)}</div>
        ${renderJobPayload(job)}
        ${job.agentId ? html`<div class="muted cron-job-agent">Agent: ${job.agentId}</div>` : nothing}
      </div>
      <div class="list-meta">
        ${renderJobState(job)}
      </div>
      <div class="cron-job-footer">
        <div class="chip-row cron-job-chips">
          <span class=${`chip ${job.enabled ? "chip-ok" : "chip-danger"}`}>
            ${job.enabled ? "enabled" : "disabled"}
          </span>
          <span class="chip">${humanLabel(job.sessionTarget)}</span>
          <span class="chip">${humanLabel(job.wakeMode)}</span>
        </div>
        <div class="row cron-job-actions">
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              props.onToggle(job, !job.enabled);
            }}
          >
            ${job.enabled ? "Disable" : "Enable"}
          </button>
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              props.onRun(job);
            }}
          >
            Run
          </button>
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              props.onEdit(job);
            }}
          >
            Edit
          </button>
          <button
            class="btn danger"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              if (window.confirm(`Remove job "${job.name}"?`)) {
                props.onRemove(job);
              }
            }}
          >
            Remove
          </button>
        </div>
      </div>
      ${isSelected ? renderInlineRuns(orderedRuns, props.basePath) : nothing}
    </div>
  `;
}

/* ── Inline run history (Step 6) ── */

function renderInlineRuns(runs: CronRunLogEntry[], basePath: string) {
  return html`
    <div class="cron-job-runs">
      <details open>
        <summary class="cron-job-runs__header">
          <span class="cron-job-runs__chevron">▸</span>
          Run history (${runs.length})
        </summary>
        <div class="cron-job-runs__content">
          ${
            runs.length === 0
              ? html`
                  <div class="muted">No runs yet.</div>
                `
              : html`
                <div class="list" style="gap: 6px;">
                  ${runs.map((entry) => renderRun(entry, basePath))}
                </div>
              `
          }
        </div>
      </details>
    </div>
  `;
}

function renderJobPayload(job: CronJob) {
  if (job.payload.kind === "systemEvent") {
    return html`<div class="cron-job-detail">
      <span class="cron-job-detail-label">${humanLabel("systemEvent")}</span>
      <span class="muted cron-job-detail-value">${job.payload.text}</span>
    </div>`;
  }

  const delivery = job.delivery;
  const deliveryTarget =
    delivery?.channel || delivery?.to
      ? ` (${delivery.channel ?? "last"}${delivery.to ? ` -> ${delivery.to}` : ""})`
      : "";

  return html`
    <div class="cron-job-detail">
      <span class="cron-job-detail-label">${humanLabel("agentTurn")}</span>
      <span class="muted cron-job-detail-value">${job.payload.message}</span>
    </div>
    ${
      delivery
        ? html`<div class="cron-job-detail">
            <span class="cron-job-detail-label">Delivery</span>
            <span class="muted cron-job-detail-value">${humanLabel(delivery.mode)}${deliveryTarget}</span>
          </div>`
        : nothing
    }
  `;
}

function formatStateRelative(ms?: number) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "n/a";
  }
  return formatRelativeTimestamp(ms);
}

function renderJobState(job: CronJob) {
  const status = job.state?.lastStatus ?? "n/a";
  const statusClass =
    status === "ok"
      ? "cron-job-status-ok"
      : status === "error"
        ? "cron-job-status-error"
        : status === "skipped"
          ? "cron-job-status-skipped"
          : "cron-job-status-na";
  const nextRunAtMs = job.state?.nextRunAtMs;
  const lastRunAtMs = job.state?.lastRunAtMs;

  return html`
    <div class="cron-job-state">
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">Status</span>
        <span class=${`cron-job-status-pill ${statusClass}`}>${status}</span>
      </div>
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">Next</span>
        <span class="cron-job-state-value" title=${formatMs(nextRunAtMs)}>
          ${formatStateRelative(nextRunAtMs)}
        </span>
      </div>
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">Last</span>
        <span class="cron-job-state-value" title=${formatMs(lastRunAtMs)}>
          ${formatStateRelative(lastRunAtMs)}
        </span>
      </div>
    </div>
  `;
}

/* ── Step 8: Relative timestamps in runs ── */

function renderRun(entry: CronRunLogEntry, basePath: string) {
  const chatUrl =
    typeof entry.sessionKey === "string" && entry.sessionKey.trim().length > 0
      ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(entry.sessionKey)}`
      : null;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${entry.status}</div>
        <div class="list-sub">${entry.summary ?? ""}</div>
      </div>
      <div class="list-meta">
        <div title=${formatMs(entry.ts)}>${formatRelativeTimestamp(entry.ts)}</div>
        <div class="muted">${formatDurationHuman(entry.durationMs ?? 0)}</div>
        ${
          chatUrl
            ? html`<div><a class="session-link" href=${chatUrl}>Open run chat</a></div>`
            : nothing
        }
        ${entry.error ? html`<div class="muted">${entry.error}</div>` : nothing}
      </div>
    </div>
  `;
}
