import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task, TaskReminder, TaskStore } from "./types.js";

// Resolved at service start from ctx.workspaceDir (the real path inside Docker)
let resolvedWorkspaceDir: string | undefined;

// Logger ref captured from api.logger at registration time
let log: { info: Function; warn: Function; error: Function } | null = null;

// Plugin config — captured at registration time
let ownerPhone: string | undefined;
let fromPhone: string | undefined;
let sidecarUrl = "http://localhost:8000";

const MAX_DELIVERY_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Deterministic reminder delivery
// ---------------------------------------------------------------------------

async function deliverReminder(task: Task): Promise<{ ok: boolean; error?: string }> {
  if (!task.reminder || !task.dueAt) {
    return { ok: false, error: "no reminder or dueAt" };
  }
  const phone = task.reminder.to || ownerPhone;
  if (!phone) {
    return {
      ok: false,
      error: "no phone number — set reminder.to or plugins.entries.task-manager.config.ownerPhone",
    };
  }

  const action = task.reminder.action;
  const body = task.reminder.note
    ? `Reminder: ${task.title}\n${task.reminder.note}`
    : `Reminder: ${task.title}`;

  try {
    if (action === "message") {
      log?.info(`[task-manager] delivering SMS for task ${task.id} to ${phone}`);
      const payload: Record<string, string> = { to: phone, body };
      if (fromPhone) payload.from_number = fromPhone;
      const resp = await fetch(`${sidecarUrl}/actions/send-sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await resp.json()) as { ok?: boolean };
      if (data.ok) {
        log?.info(`[task-manager] SMS delivered for task ${task.id}`);
        return { ok: true };
      }
      return { ok: false, error: `sidecar returned: ${JSON.stringify(data)}` };
    }

    if (action === "call") {
      log?.info(`[task-manager] initiating call for task ${task.id} to ${phone}`);
      const callPayload: Record<string, string> = { to: phone, purpose: body };
      if (fromPhone) callPayload.from_number = fromPhone;
      const resp = await fetch(`${sidecarUrl}/actions/make-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(callPayload),
      });
      const data = (await resp.json()) as { ok?: boolean };
      if (data.ok) {
        log?.info(`[task-manager] call initiated for task ${task.id}`);
        return { ok: true };
      }
      return { ok: false, error: `sidecar returned: ${JSON.stringify(data)}` };
    }

    return { ok: false, error: `unknown action: ${action}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function getTasksDir(): string {
  const workspaceDir =
    resolvedWorkspaceDir ??
    process.env.OPENCLAW_WORKSPACE_DIR ??
    join(process.env.HOME ?? "/tmp", ".openclaw", "workspace");
  return join(workspaceDir, ".tasks");
}

async function ensureTasksDir(): Promise<string> {
  const dir = getTasksDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

async function loadTasks(): Promise<TaskStore> {
  const dir = getTasksDir();
  try {
    const raw = await readFile(join(dir, "tasks.json"), "utf-8");
    return JSON.parse(raw) as TaskStore;
  } catch {
    return { tasks: [] };
  }
}

async function saveTasks(store: TaskStore): Promise<void> {
  const dir = await ensureTasksDir();
  await writeFile(join(dir, "tasks.json"), JSON.stringify(store, null, 2), "utf-8");
}

function generateId(): string {
  return randomBytes(3).toString("hex");
}

export default {
  id: "task-manager",
  name: "Task Manager",

  register(api: OpenClawPluginApi) {
    log = api.logger as any;

    // Capture plugin config
    const cfg = (api.pluginConfig ?? {}) as {
      ownerPhone?: string;
      sidecarUrl?: string;
      fromPhone?: string;
    };
    ownerPhone = cfg.ownerPhone || process.env.OWNER_PHONE_NUMBER || undefined;
    fromPhone = cfg.fromPhone || process.env.TWILIO_PHONE_NUMBER || undefined;
    if (cfg.sidecarUrl) sidecarUrl = cfg.sidecarUrl;
    else if (process.env.SIDECAR_URL) sidecarUrl = process.env.SIDECAR_URL;

    if (ownerPhone) {
      log?.info(`[task-manager] ownerPhone configured: ${ownerPhone}`);
    } else {
      log?.warn("[task-manager] ownerPhone not configured — reminders will fail until set");
    }
    log?.info(`[task-manager] sidecarUrl: ${sidecarUrl}`);

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "task_add",
        label: "Task Add",
        description:
          "Add a task to the user's todo list. Use when the user asks to remember, track, or add something to their tasks/todos. " +
          "Also handles reminders: if the user says 'remind me to X at Y', create a task with dueAt and a reminder. " +
          "The reminder will proactively call or message the user at the scheduled time.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Task title" },
            notes: { type: "string", description: "Optional notes or details" },
            dueDate: {
              type: "string",
              description: "Optional due date (ISO date string, e.g. 2026-02-14)",
            },
            dueAt: {
              type: "string",
              description:
                "Precise ISO datetime for when a reminder should fire (e.g. 2026-02-14T20:00:00). Required if reminder is set.",
            },
            assignee: {
              type: "string",
              description:
                "Agent ID to assign this task to (e.g. 'main'). Defaults to unassigned (user task).",
            },
            reminder: {
              type: "object",
              description: "Set a proactive reminder — the system will call or text at dueAt.",
              properties: {
                action: {
                  type: "string",
                  enum: ["call", "message"],
                  description: "How to remind: 'call' for voice call, 'message' for SMS text",
                },
                to: {
                  type: "string",
                  description:
                    "Phone number to contact in E.164 format (e.g. +15551234567). Defaults to the owner's number if omitted.",
                },
                note: { type: "string", description: "Extra context for the reminder delivery" },
              },
              required: ["action"],
            },
          },
          required: ["title"],
        },
        async execute(_toolCallId, params) {
          const { title, notes, dueDate, dueAt, assignee, reminder } = params as {
            title: string;
            notes?: string;
            dueDate?: string;
            dueAt?: string;
            assignee?: string;
            reminder?: { action: "call" | "message"; to?: string; note?: string };
          };

          const now = new Date().toISOString();
          const task: Task = {
            id: generateId(),
            title,
            status: "open",
            notes,
            dueDate,
            dueAt,
            assignee,
            reminder: reminder
              ? { action: reminder.action, to: reminder.to, note: reminder.note }
              : undefined,
            createdAt: now,
            updatedAt: now,
          };

          const store = await loadTasks();
          store.tasks.push(task);
          await saveTasks(store);

          let text = `Task added: "${task.title}" (${task.id})`;
          if (dueDate) text += ` — due ${dueDate}`;
          if (dueAt && reminder) {
            text += ` — reminder: ${reminder.action} at ${dueAt}`;
          }

          return {
            content: [{ type: "text" as const, text }],
            details: { id: task.id, title: task.title, dueDate, dueAt, reminder },
          };
        },
      },
      { name: "task_add" },
    );

    api.registerTool(
      {
        name: "task_list",
        label: "Task List",
        description:
          "List tasks from the user's todo list. Use when the user asks to see, show, or check their tasks/todos. " +
          "Each task includes completedAt when it was marked done. Default filter 'all' shows open + done (excludes archived).",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["open", "done", "archived", "all", "everything"],
              description:
                "Filter by status. 'all' = open + done (default), 'everything' = includes archived.",
            },
          },
        },
        async execute(_toolCallId, params) {
          const { status = "all" } = (params ?? {}) as {
            status?: "open" | "done" | "archived" | "all" | "everything";
          };

          const store = await loadTasks();
          let filtered: Task[];
          if (status === "everything") {
            filtered = store.tasks;
          } else if (status === "all") {
            filtered = store.tasks.filter((t) => t.status !== "archived");
          } else {
            filtered = store.tasks.filter((t) => t.status === status);
          }

          if (filtered.length === 0) {
            const qualifier = status === "all" ? "" : ` with status "${status}"`;
            return {
              content: [{ type: "text" as const, text: `No tasks found${qualifier}.` }],
              details: { tasks: [] },
            };
          }

          const lines = filtered.map((t) => {
            const check =
              t.status === "archived" ? "[archived]" : t.status === "done" ? "[x]" : "[ ]";
            let line = `- ${check} ${t.title} (${t.id})`;
            if (t.dueDate) line += ` — due ${t.dueDate}`;
            if (t.dueAt && t.reminder) {
              line += ` — reminder: ${t.reminder.action} at ${t.dueAt}`;
              if (t.reminder.delivered) line += " (delivered)";
            }
            if (t.completedAt) line += ` — completed ${t.completedAt}`;
            if (t.notes) line += `\n  ${t.notes}`;
            return line;
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `${filtered.length} task${filtered.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
              },
            ],
            details: { tasks: filtered },
          };
        },
      },
      { name: "task_list" },
    );

    api.registerTool(
      {
        name: "task_update",
        label: "Task Update",
        description:
          "Update a task — change its title, notes, due date, reminder, or mark it as done/open/archived. " +
          "Use when the user asks to complete, finish, reopen, archive, or edit a task. " +
          "Marking a task 'done' automatically records a completedAt timestamp. " +
          "Reopening to 'open' clears it. Archiving preserves completedAt.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task ID to update" },
            title: { type: "string", description: "New title" },
            notes: { type: "string", description: "New notes (replaces existing)" },
            dueDate: { type: "string", description: "New due date (ISO date string)" },
            dueAt: {
              type: "string",
              description: "New precise ISO datetime for reminder trigger",
            },
            assignee: { type: "string", description: "Agent ID to assign this task to" },
            reminder: {
              type: "object",
              description: "Update or set a reminder. Omit to leave unchanged.",
              properties: {
                action: {
                  type: "string",
                  enum: ["call", "message"],
                  description: "How to remind",
                },
                to: {
                  type: "string",
                  description: "Phone number in E.164 format. Defaults to owner's number.",
                },
                note: { type: "string", description: "Extra context" },
              },
              required: ["action"],
            },
            status: {
              type: "string",
              enum: ["open", "done", "archived"],
              description: "New status",
            },
          },
          required: ["id"],
        },
        async execute(_toolCallId, params) {
          const { id, title, notes, dueDate, dueAt, assignee, reminder, status } = params as {
            id: string;
            title?: string;
            notes?: string;
            dueDate?: string;
            dueAt?: string;
            assignee?: string;
            reminder?: { action: "call" | "message"; to?: string; note?: string };
            status?: "open" | "done" | "archived";
          };

          const store = await loadTasks();
          const task = store.tasks.find((t) => t.id === id);
          if (!task) {
            return {
              content: [{ type: "text" as const, text: `Task not found: ${id}` }],
              details: { error: "not_found" },
            };
          }

          if (title !== undefined) task.title = title;
          if (notes !== undefined) task.notes = notes;
          if (dueDate !== undefined) task.dueDate = dueDate;
          if (dueAt !== undefined) task.dueAt = dueAt;
          if (assignee !== undefined) task.assignee = assignee;
          if (reminder !== undefined) {
            task.reminder = {
              action: reminder.action,
              to: reminder.to,
              note: reminder.note,
            };
          }
          // If dueAt or reminder changed, reset delivered flag so it re-fires
          if (dueAt !== undefined || reminder !== undefined) {
            if (task.reminder) task.reminder.delivered = undefined;
          }
          if (status !== undefined) {
            const prevStatus = task.status;
            task.status = status;
            if (status === "done" && prevStatus !== "done") {
              task.completedAt = new Date().toISOString();
            } else if (status === "open") {
              task.completedAt = undefined;
            }
          }
          task.updatedAt = new Date().toISOString();

          await saveTasks(store);

          const check =
            task.status === "archived" ? "[archived]" : task.status === "done" ? "[x]" : "[ ]";
          let text = `Task updated: ${check} "${task.title}" (${task.id})`;
          if (task.dueDate) text += ` — due ${task.dueDate}`;
          if (task.dueAt && task.reminder) {
            text += ` — reminder: ${task.reminder.action} at ${task.dueAt}`;
            if (task.reminder.delivered) text += " (delivered)";
          }
          if (task.completedAt) text += ` — completed ${task.completedAt}`;

          return {
            content: [{ type: "text" as const, text }],
            details: { id: task.id, title: task.title, status: task.status },
          };
        },
      },
      { name: "task_update" },
    );

    api.registerTool(
      {
        name: "task_remove",
        label: "Task Remove",
        description:
          "Remove a task from the user's todo list. Use when the user asks to delete or remove a task.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task ID to remove" },
          },
          required: ["id"],
        },
        async execute(_toolCallId, params) {
          const { id } = params as { id: string };

          const store = await loadTasks();
          const idx = store.tasks.findIndex((t) => t.id === id);
          if (idx === -1) {
            return {
              content: [{ type: "text" as const, text: `Task not found: ${id}` }],
              details: { error: "not_found" },
            };
          }

          const [removed] = store.tasks.splice(idx, 1);
          await saveTasks(store);

          return {
            content: [{ type: "text" as const, text: `Task removed: "${removed.title}" (${id})` }],
            details: { id, title: removed.title },
          };
        },
      },
      { name: "task_remove" },
    );

    // ========================================================================
    // Gateway methods (Control UI)
    // ========================================================================

    api.registerGatewayMethod("tasks.list", async ({ params, respond }) => {
      try {
        const status =
          typeof params?.status === "string"
            ? (params.status as "open" | "done" | "archived" | "all" | "everything")
            : "all";
        const store = await loadTasks();
        let tasks: Task[];
        if (status === "everything") {
          tasks = store.tasks;
        } else if (status === "all") {
          tasks = store.tasks.filter((t) => t.status !== "archived");
        } else {
          tasks = store.tasks.filter((t) => t.status === status);
        }
        respond(true, { tasks });
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });

    api.registerGatewayMethod("tasks.add", async ({ params, respond }) => {
      try {
        const title = typeof params?.title === "string" ? params.title.trim() : "";
        if (!title) {
          respond(false, { error: "Title is required." });
          return;
        }
        const notes = typeof params?.notes === "string" ? params.notes.trim() : undefined;
        const dueDate = typeof params?.dueDate === "string" ? params.dueDate.trim() : undefined;
        const dueAt = typeof params?.dueAt === "string" ? params.dueAt.trim() : undefined;
        const assignee = typeof params?.assignee === "string" ? params.assignee.trim() : undefined;
        const reminderParam = params?.reminder as
          | { action?: string; to?: string; note?: string }
          | undefined;
        const reminder: TaskReminder | undefined =
          reminderParam?.action === "call" || reminderParam?.action === "message"
            ? {
                action: reminderParam.action,
                to:
                  typeof reminderParam.to === "string"
                    ? reminderParam.to.trim() || undefined
                    : undefined,
                note:
                  typeof reminderParam.note === "string"
                    ? reminderParam.note.trim() || undefined
                    : undefined,
              }
            : undefined;

        const now = new Date().toISOString();
        const task: Task = {
          id: generateId(),
          title,
          status: "open",
          notes: notes || undefined,
          dueDate: dueDate || undefined,
          dueAt: dueAt || undefined,
          assignee: assignee || undefined,
          reminder,
          createdAt: now,
          updatedAt: now,
        };
        const store = await loadTasks();
        store.tasks.push(task);
        await saveTasks(store);
        respond(true, { task });
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });

    api.registerGatewayMethod("tasks.update", async ({ params, respond }) => {
      try {
        const id = typeof params?.id === "string" ? params.id : "";
        if (!id) {
          respond(false, { error: "Task ID is required." });
          return;
        }
        const store = await loadTasks();
        const task = store.tasks.find((t) => t.id === id);
        if (!task) {
          respond(false, { error: `Task not found: ${id}` });
          return;
        }

        const reminderParam = params?.reminder as
          | { action?: string; to?: string; note?: string }
          | undefined;
        const newReminder: TaskReminder | undefined =
          reminderParam?.action === "call" || reminderParam?.action === "message"
            ? {
                action: reminderParam.action,
                to:
                  typeof reminderParam.to === "string"
                    ? reminderParam.to.trim() || undefined
                    : undefined,
                note:
                  typeof reminderParam.note === "string"
                    ? reminderParam.note.trim() || undefined
                    : undefined,
              }
            : undefined;

        if (typeof params?.title === "string") task.title = params.title.trim();
        if (typeof params?.notes === "string") task.notes = params.notes.trim() || undefined;
        if (typeof params?.dueDate === "string") task.dueDate = params.dueDate.trim() || undefined;
        if (params?.dueAt !== undefined) {
          task.dueAt =
            typeof params.dueAt === "string" ? params.dueAt.trim() || undefined : undefined;
        }
        if (params?.assignee !== undefined) {
          task.assignee =
            typeof params.assignee === "string" ? params.assignee.trim() || undefined : undefined;
        }
        if (newReminder !== undefined) task.reminder = newReminder;
        // Reset delivered flag when dueAt or reminder changes
        if ((params?.dueAt !== undefined || newReminder !== undefined) && task.reminder) {
          task.reminder.delivered = undefined;
        }
        if (
          params?.status === "open" ||
          params?.status === "done" ||
          params?.status === "archived"
        ) {
          const prevStatus = task.status;
          task.status = params.status;
          if (params.status === "done" && prevStatus !== "done") {
            task.completedAt = new Date().toISOString();
          } else if (params.status === "open") {
            task.completedAt = undefined;
          }
        }
        task.updatedAt = new Date().toISOString();

        await saveTasks(store);
        respond(true, { task });
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });

    api.registerGatewayMethod("tasks.remove", async ({ params, respond }) => {
      try {
        const id = typeof params?.id === "string" ? params.id : "";
        if (!id) {
          respond(false, { error: "Task ID is required." });
          return;
        }
        const store = await loadTasks();
        const idx = store.tasks.findIndex((t) => t.id === id);
        if (idx === -1) {
          respond(false, { error: `Task not found: ${id}` });
          return;
        }
        const [removed] = store.tasks.splice(idx, 1);
        await saveTasks(store);
        respond(true, { id, title: removed.title });
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });

    api.registerGatewayMethod("tasks.archiveDone", async ({ respond }) => {
      try {
        const store = await loadTasks();
        const now = new Date().toISOString();
        let count = 0;
        for (const task of store.tasks) {
          if (task.status === "done") {
            task.status = "archived";
            task.updatedAt = now;
            count++;
          }
        }
        if (count > 0) await saveTasks(store);
        respond(true, { count });
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });

    // ========================================================================
    // Service (reminder delivery loop)
    // ========================================================================

    api.registerService({
      id: "task-manager",
      async start(ctx) {
        if (ctx.workspaceDir) {
          resolvedWorkspaceDir = ctx.workspaceDir;
          ctx.logger.info(`task-manager: workspace → ${resolvedWorkspaceDir}`);
        } else {
          ctx.logger.warn("task-manager: no workspaceDir from service context, using fallback");
        }
        await ensureTasksDir();

        // Reminder delivery loop — checks every 5s for due reminders and delivers them
        // deterministically via the Twilio sidecar (no LLM involved).
        const deliveryInterval = setInterval(async () => {
          try {
            const store = await loadTasks();
            let dirty = false;
            const now = Date.now();

            for (const task of store.tasks) {
              if (
                task.status === "open" &&
                task.dueAt &&
                task.reminder &&
                !task.reminder.delivered
              ) {
                const dueMs = new Date(task.dueAt).getTime();
                if (now >= dueMs) {
                  const attempts = (task.reminder as any)._attempts ?? 0;
                  if (attempts >= MAX_DELIVERY_ATTEMPTS) {
                    task.reminder.delivered = true;
                    task.reminder.deliveryError = `failed after ${attempts} attempts`;
                    task.updatedAt = new Date().toISOString();
                    dirty = true;
                    ctx.logger.error(
                      `task-manager: giving up on task ${task.id} after ${attempts} attempts`,
                    );
                    continue;
                  }

                  ctx.logger.info(
                    `task-manager: reminder due for task ${task.id} "${task.title}" — delivering ${task.reminder.action} (attempt ${attempts + 1}/${MAX_DELIVERY_ATTEMPTS})`,
                  );
                  const result = await deliverReminder(task);
                  if (result.ok) {
                    task.reminder.delivered = true;
                    task.reminder.deliveryError = undefined;
                    task.updatedAt = new Date().toISOString();
                    dirty = true;
                    ctx.logger.info(`task-manager: reminder delivered for task ${task.id}`);
                  } else {
                    (task.reminder as any)._attempts = attempts + 1;
                    dirty = true;
                    ctx.logger.error(
                      `task-manager: delivery failed for task ${task.id} (attempt ${attempts + 1}): ${result.error}`,
                    );
                  }
                }
              }
            }

            if (dirty) await saveTasks(store);
          } catch (err) {
            ctx.logger.warn(`task-manager: delivery interval error: ${err}`);
          }
        }, 5_000);

        const cleanup = () => clearInterval(deliveryInterval);
        process.once("SIGTERM", cleanup);
        process.once("SIGINT", cleanup);
      },
    });
  },
};
