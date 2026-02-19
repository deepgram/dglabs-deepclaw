import { html, nothing } from "lit";
import type { TaskItem } from "../types.ts";
import type { TaskFormState } from "../ui-types.ts";
import { formatRelativeTimestamp } from "../format.ts";

export type TasksProps = {
  loading: boolean;
  tasks: TaskItem[];
  error: string | null;
  busy: boolean;
  form: TaskFormState;
  editingId: string | null;
  formOpen: boolean;
  filter: "open" | "done" | "archived" | "all";
  expandedId: string | null;
  onFormChange: (patch: Partial<TaskFormState>) => void;
  onFilterChange: (filter: "open" | "done" | "archived" | "all") => void;
  onRefresh: () => void;
  onNewTask: () => void;
  onAdd: () => void;
  onSave: () => void;
  onEdit: (task: TaskItem) => void;
  onCancelEdit: () => void;
  onToggle: (task: TaskItem) => void;
  onRemove: (task: TaskItem) => void;
  onExpand: (taskId: string | null) => void;
  onArchive: (task: TaskItem) => void;
  onArchiveAllDone: () => void;
};

export function renderTasks(props: TasksProps) {
  const isEditing = props.editingId != null;
  const showForm = props.formOpen || isEditing;
  let filtered: TaskItem[];
  if (props.filter === "all") {
    filtered = props.tasks.filter((t) => t.status !== "archived");
  } else {
    filtered = props.tasks.filter((t) => t.status === props.filter);
  }
  const openCount = props.tasks.filter((t) => t.status === "open").length;
  const doneCount = props.tasks.filter((t) => t.status === "done").length;
  const archivedCount = props.tasks.filter((t) => t.status === "archived").length;

  return html`
    ${renderStatusBar(props, openCount, doneCount, archivedCount)}

    ${
      showForm
        ? html`
            <div class="card" style="margin-top: 18px;">
              <div class="card-title">${isEditing ? "Edit Task" : "New Task"}</div>
              ${renderForm(props, isEditing)}
            </div>
          `
        : nothing
    }

    <section class="card" style="margin-top: 18px;">
      ${
        filtered.length === 0
          ? html`
              <div class="muted">
                ${props.tasks.length === 0 ? "No tasks yet." : "No tasks match the current filter."}
              </div>
            `
          : filtered.map((task) => renderTask(task, props))
      }
    </section>
  `;
}

function renderStatusBar(
  props: TasksProps,
  openCount: number,
  doneCount: number,
  archivedCount: number,
) {
  return html`
    <div class="cron-status-bar">
      <span class="cron-status-bar__item">
        <span class="chip chip-ok" style="margin-right: 4px;">${openCount}</span> open
      </span>
      <span class="cron-status-bar__sep"></span>
      <span class="cron-status-bar__item">
        <span class="chip" style="margin-right: 4px;">${doneCount}</span> done
      </span>
      ${
        archivedCount > 0
          ? html`
              <span class="cron-status-bar__sep"></span>
              <span class="cron-status-bar__item">
                <span class="chip" style="margin-right: 4px; opacity: 0.5;">${archivedCount}</span>
                archived
              </span>
            `
          : nothing
      }
      <span class="cron-status-bar__sep"></span>
      <span class="cron-status-bar__item">
        <select
          .value=${props.filter}
          @change=${(e: Event) =>
            props.onFilterChange(
              (e.target as HTMLSelectElement).value as "open" | "done" | "archived" | "all",
            )}
          style="font-size: 12px; padding: 2px 4px;"
        >
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>
      </span>
      <span class="cron-status-bar__spacer"></span>
      ${props.error ? html`<span class="muted" style="font-size: 12px;">${props.error}</span>` : nothing}
      ${
        doneCount > 0 && props.filter !== "archived"
          ? html`<button
              class="btn btn--sm"
              ?disabled=${props.busy}
              @click=${props.onArchiveAllDone}
            >
              Archive done
            </button>`
          : nothing
      }
      <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
        ${props.loading ? "Refreshing…" : "Refresh"}
      </button>
      ${
        !props.formOpen && !props.editingId
          ? html`<button class="btn btn--sm primary" @click=${props.onNewTask}>New Task</button>`
          : nothing
      }
    </div>
  `;
}

function formatReminderTime(dueAt: string): string {
  try {
    const d = new Date(dueAt);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return dueAt;
  }
}

function renderForm(props: TasksProps, isEditing: boolean) {
  const hasReminder =
    props.form.reminderAction === "call" || props.form.reminderAction === "message";
  return html`
    <div class="form-grid" style="margin-top: 16px;">
      <label class="field">
        <span>Title</span>
        <input
          .value=${props.form.title}
          @input=${(e: Event) => props.onFormChange({ title: (e.target as HTMLInputElement).value })}
          placeholder="What needs to be done?"
        />
      </label>
      <label class="field">
        <span>Due date</span>
        <input
          type="date"
          .value=${props.form.dueDate}
          @input=${(e: Event) =>
            props.onFormChange({ dueDate: (e.target as HTMLInputElement).value })}
        />
      </label>
    </div>
    <label class="field" style="margin-top: 12px;">
      <span>Notes</span>
      <textarea
        .value=${props.form.notes}
        @input=${(e: Event) =>
          props.onFormChange({ notes: (e.target as HTMLTextAreaElement).value })}
        rows="2"
        placeholder="Optional details…"
      ></textarea>
    </label>

    <!-- Reminder section -->
    <details style="margin-top: 14px;" .open=${hasReminder}>
      <summary style="cursor: pointer; font-size: 13px; font-weight: 500; user-select: none;">
        Reminder ${hasReminder ? "(active)" : ""}
      </summary>
      <div class="form-grid" style="margin-top: 10px;">
        <label class="field">
          <span>Reminder action</span>
          <select
            .value=${props.form.reminderAction}
            @change=${(e: Event) =>
              props.onFormChange({ reminderAction: (e.target as HTMLSelectElement).value })}
          >
            <option value="">None</option>
            <option value="call">Call</option>
            <option value="message">Message</option>
          </select>
        </label>
        <label class="field">
          <span>Remind at</span>
          <input
            type="datetime-local"
            .value=${props.form.dueAt}
            @input=${(e: Event) =>
              props.onFormChange({ dueAt: (e.target as HTMLInputElement).value })}
          />
        </label>
      </div>
      ${
        hasReminder
          ? html`
              <div class="form-grid" style="margin-top: 8px;">
                <label class="field">
                  <span>Channel</span>
                  <input
                    .value=${props.form.reminderChannel}
                    @input=${(e: Event) =>
                      props.onFormChange({ reminderChannel: (e.target as HTMLInputElement).value })}
                    placeholder="e.g. twilio-sms (optional)"
                  />
                </label>
                <label class="field">
                  <span>Assignee</span>
                  <input
                    .value=${props.form.assignee}
                    @input=${(e: Event) =>
                      props.onFormChange({ assignee: (e.target as HTMLInputElement).value })}
                    placeholder="e.g. main (optional)"
                  />
                </label>
              </div>
              <label class="field" style="margin-top: 8px;">
                <span>Reminder note</span>
                <input
                  .value=${props.form.reminderNote}
                  @input=${(e: Event) =>
                    props.onFormChange({ reminderNote: (e.target as HTMLInputElement).value })}
                  placeholder="Extra context for the reminder (optional)"
                />
              </label>
            `
          : nothing
      }
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
                ${props.busy ? "Adding…" : "Add task"}
              </button>
            `
      }
    </div>
  `;
}

const EXPAND_THRESHOLD = 60;

function renderTask(task: TaskItem, props: TasksProps) {
  const isDone = task.status === "done";
  const isArchived = task.status === "archived";
  const isDimmed = isDone || isArchived;
  const isEditTarget = props.editingId === task.id;
  const isExpanded = props.expandedId === task.id;
  const hasReminder = Boolean(task.dueAt && task.reminder);
  const detailText = [task.notes, task.dueDate, task.dueAt].filter(Boolean).join(" ");
  const expandable = detailText.length > EXPAND_THRESHOLD || hasReminder;
  const hasInlineDetail = detailText.length > 0 && !expandable;

  return html`
    <div
      style="
        padding: 6px 0;
        border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
        ${isEditTarget ? "opacity: 0.5;" : ""}
      "
    >
      <div
        style="
          display: flex;
          align-items: center;
          gap: 10px;
          ${isDimmed ? "opacity: 0.5;" : ""}
          ${isArchived ? "opacity: 0.35;" : ""}
          ${expandable ? "cursor: pointer;" : ""}
        "
        @click=${() => {
          if (expandable) {
            props.onExpand(isExpanded ? null : task.id);
          }
        }}
      >
        <input
          type="checkbox"
          .checked=${isDone || isArchived}
          @change=${(e: Event) => {
            e.stopPropagation();
            if (!isArchived) {
              props.onToggle(task);
            }
          }}
          @click=${(e: Event) => e.stopPropagation()}
          style="cursor: ${isArchived ? "default" : "pointer"}; flex-shrink: 0;"
          ?disabled=${props.busy || isArchived}
        />
        ${
          expandable
            ? html`<span style="flex-shrink: 0; font-size: 10px; opacity: 0.4; width: 10px;">${isExpanded ? "▾" : "▸"}</span>`
            : html`
                <span style="flex-shrink: 0; width: 10px"></span>
              `
        }
        <span style="flex: 1; min-width: 0; ${isDimmed ? "text-decoration: line-through;" : ""}">
          ${task.title}
          ${
            hasReminder
              ? html`<span
                  class="chip"
                  style="margin-left: 6px; font-size: 10px; vertical-align: middle; opacity: ${isDimmed ? "0.5" : "0.8"};"
                  title="Reminder: ${task.reminder!.action} at ${task.dueAt}"
                >${task.reminder!.action === "call" ? "\u{1F4DE}" : "\u{1F4AC}"} ${formatReminderTime(task.dueAt!)}</span>`
              : nothing
          }
          ${hasInlineDetail ? html`<span class="muted" style="font-size: 11px; margin-left: 8px;">${detailText}</span>` : nothing}
        </span>
        ${
          task.dueDate
            ? html`<span class="muted" style="font-size: 11px; flex-shrink: 0;">${task.dueDate}</span>`
            : nothing
        }
        <span class="muted" style="font-size: 11px; flex-shrink: 0;">
          ${formatRelativeTimestamp(new Date(task.updatedAt).getTime())}
        </span>
        ${
          !isArchived
            ? html`
                <button
                  class="btn btn--sm"
                  ?disabled=${props.busy}
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    props.onEdit(task);
                  }}
                  style="flex-shrink: 0;"
                >
                  Edit
                </button>
              `
            : nothing
        }
        ${
          isDone
            ? html`
                <button
                  class="btn btn--sm"
                  ?disabled=${props.busy}
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    props.onArchive(task);
                  }}
                  style="flex-shrink: 0;"
                >
                  Archive
                </button>
              `
            : nothing
        }
        <button
          class="btn btn--sm danger"
          ?disabled=${props.busy}
          @click=${(e: Event) => {
            e.stopPropagation();
            if (window.confirm(`Remove "${task.title}"?`)) {
              props.onRemove(task);
            }
          }}
          style="flex-shrink: 0;"
        >
          Remove
        </button>
      </div>
      ${
        isExpanded
          ? html`
              <div class="muted" style="padding: 6px 0 2px 52px; font-size: 12px; line-height: 1.5;">
                ${task.notes ? html`<div>${task.notes}</div>` : nothing}
                ${task.dueDate ? html`<div>Due: ${task.dueDate}</div>` : nothing}
                ${
                  hasReminder
                    ? html`
                        <div>
                          Reminder: ${task.reminder!.action}
                          at ${new Date(task.dueAt!).toLocaleString()}
                          ${task.reminder!.channel ? html` via ${task.reminder!.channel}` : nothing}
                          ${task.assignee ? html` (agent: ${task.assignee})` : nothing}
                        </div>
                        ${task.reminder!.note ? html`<div>Reminder note: ${task.reminder!.note}</div>` : nothing}
                        ${task.reminder!.cronJobId ? html`<div>Cron job: ${task.reminder!.cronJobId}</div>` : nothing}
                      `
                    : nothing
                }
                ${task.completedAt ? html`<div>Completed: ${new Date(task.completedAt).toLocaleString()}</div>` : nothing}
                <div>Created: ${new Date(task.createdAt).toLocaleString()}</div>
                <div>ID: ${task.id}</div>
              </div>
            `
          : nothing
      }
    </div>
  `;
}
