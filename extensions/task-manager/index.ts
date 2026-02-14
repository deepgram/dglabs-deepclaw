import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task, TaskReminder, TaskStore } from "./types.js";

// Resolved at service start from ctx.workspaceDir (the real path inside Docker)
let resolvedWorkspaceDir: string | undefined;

// Captured from the first gateway method call so the service interval can schedule cron jobs
let cronServiceRef: { add: Function; remove: Function; list: Function } | null = null;

// Logger ref captured from api.logger at registration time
let log: { info: Function; warn: Function; error: Function } | null = null;

// ---------------------------------------------------------------------------
// Reminder helpers
// ---------------------------------------------------------------------------

function buildReminderPrompt(task: Task): string {
  const note = task.reminder!.note ? `\nAdditional context: ${task.reminder!.note}` : "";
  const notesLine = task.notes ? `Task notes: ${task.notes}` : "";

  if (task.reminder!.action === "call") {
    // Voice call reminder
    const lines = [
      `REMINDER TASK: "${task.title}" (task ID: ${task.id})`,
      "",
      `You MUST use the voice_call tool to call the user about this reminder.`,
      `Call them with: voice_call({ action: "initiate_call", message: "<your reminder message>" }). Voice calls and SMS are the preferred delivery channels.`,
      `Do NOT just respond with text — you must actually place the call using the tool.`,
      note,
      notesLine,
      "",
      `After the call is placed, call task_update({ id: "${task.id}", status: "done" }) to mark this task complete.`,
    ];
    return lines.filter(Boolean).join("\n");
  }

  // Message reminder
  const channel = task.reminder!.channel;
  const channelHint = channel
    ? `Use channel "${channel}": message({ action: "send", channel: "${channel}", message: "<your reminder>" })`
    : `Use the message tool: message({ action: "send", message: "<your reminder>" }). Prefer SMS (twilio-sms) above other channels — SMS reaches the user's phone directly.`;

  const lines = [
    `REMINDER TASK: "${task.title}" (task ID: ${task.id})`,
    "",
    `You MUST use the message tool to send a message to the user about this reminder.`,
    channelHint,
    `Do NOT just respond with text — you must actually send the message using the message tool.`,
    note,
    notesLine,
    "",
    `After the message is sent, call task_update({ id: "${task.id}", status: "done" }) to mark this task complete.`,
  ];
  return lines.filter(Boolean).join("\n");
}

async function scheduleCronForTask(
  task: Task,
  cron: { add: Function },
): Promise<string | undefined> {
  if (!task.dueAt || !task.reminder) {
    log?.warn(`[task-manager] scheduleCron: skipped task ${task.id} — missing dueAt or reminder`);
    return undefined;
  }

  const message = buildReminderPrompt(task);
  log?.info(
    `[task-manager] scheduleCron: creating cron for task ${task.id} "${task.title}" at ${task.dueAt} action=${task.reminder.action}`,
  );
  log?.info(`[task-manager] scheduleCron: prompt for task ${task.id}:\n${message}`);

  const job = await cron.add({
    name: `reminder:${task.id}`,
    description: `Task reminder: ${task.title}`,
    enabled: true,
    deleteAfterRun: true,
    schedule: { kind: "at", at: task.dueAt },
    sessionTarget: "isolated",
    wakeMode: "now",
    agentId: task.assignee,
    payload: {
      kind: "agentTurn",
      message,
      timeoutSeconds: 120,
    },
  });

  const jobId = (job as { id: string }).id;
  log?.info(`[task-manager] scheduleCron: created cron job ${jobId} for task ${task.id}`);
  return jobId;
}

async function removeCronForTask(task: Task, cron: { remove: Function }): Promise<void> {
  if (task.reminder?.cronJobId) {
    log?.info(
      `[task-manager] removeCron: removing cron job ${task.reminder.cronJobId} for task ${task.id}`,
    );
    try {
      await cron.remove(task.reminder.cronJobId);
      log?.info(`[task-manager] removeCron: removed cron job ${task.reminder.cronJobId}`);
    } catch (err) {
      log?.warn(`[task-manager] removeCron: failed to remove ${task.reminder.cronJobId}: ${err}`);
    }
  }
}

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
              description:
                "Set a proactive reminder — the assigned agent will call or message the user at dueAt.",
              properties: {
                action: {
                  type: "string",
                  enum: ["call", "message"],
                  description:
                    "How to remind: 'call' for voice call, 'message' for text/channel message",
                },
                channel: {
                  type: "string",
                  description:
                    "Channel to use (e.g. 'twilio-sms', 'whatsapp'). Agent picks if omitted.",
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
            reminder?: { action: "call" | "message"; channel?: string; note?: string };
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
              ? { action: reminder.action, channel: reminder.channel, note: reminder.note }
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
            log?.info(
              `[task-manager] task_add tool: task ${task.id} has reminder, cronServiceRef=${cronServiceRef ? "available" : "null"}`,
            );
            if (!cronServiceRef) {
              text += " (cron job will be scheduled shortly by the service)";
              log?.warn(
                `[task-manager] task_add tool: cronServiceRef is null, deferring to service interval`,
              );
            }
          }

          // Try to schedule cron immediately if ref is available
          if (dueAt && reminder && cronServiceRef) {
            try {
              log?.info(`[task-manager] task_add tool: scheduling cron for task ${task.id}`);
              const cronJobId = await scheduleCronForTask(task, cronServiceRef);
              if (cronJobId) {
                task.reminder!.cronJobId = cronJobId;
                await saveTasks(store);
                text += ` [cron: ${cronJobId}]`;
                log?.info(
                  `[task-manager] task_add tool: cron ${cronJobId} scheduled for task ${task.id}`,
                );
              }
            } catch (err) {
              log?.error(
                `[task-manager] task_add tool: failed to schedule cron for task ${task.id}: ${err}`,
              );
              // Service interval will pick it up
            }
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
            if (t.dueAt && t.reminder) line += ` — reminder: ${t.reminder.action} at ${t.dueAt}`;
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
          "Marking a task 'done' automatically records a completedAt timestamp and removes any pending reminder. " +
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
              description:
                "Update or set a reminder. Omit to leave unchanged. Set action to empty string to clear.",
              properties: {
                action: {
                  type: "string",
                  enum: ["call", "message"],
                  description: "How to remind",
                },
                channel: { type: "string", description: "Channel to use" },
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
            reminder?: { action: "call" | "message"; channel?: string; note?: string };
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

          const needsReschedule =
            (dueAt !== undefined && dueAt !== task.dueAt) || reminder !== undefined;

          if (title !== undefined) task.title = title;
          if (notes !== undefined) task.notes = notes;
          if (dueDate !== undefined) task.dueDate = dueDate;
          if (dueAt !== undefined) task.dueAt = dueAt;
          if (assignee !== undefined) task.assignee = assignee;
          if (reminder !== undefined) {
            task.reminder = {
              action: reminder.action,
              channel: reminder.channel,
              note: reminder.note,
              cronJobId: task.reminder?.cronJobId,
            };
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

          // Handle cron rescheduling if cronServiceRef is available
          log?.info(
            `[task-manager] task_update tool: task ${task.id} status=${task.status} needsReschedule=${needsReschedule} cronServiceRef=${cronServiceRef ? "available" : "null"}`,
          );
          if (cronServiceRef) {
            const shouldRemoveCron = status === "done" || status === "archived" || needsReschedule;

            if (shouldRemoveCron) {
              log?.info(
                `[task-manager] task_update tool: removing cron for task ${task.id} (status=${status}, needsReschedule=${needsReschedule})`,
              );
              await removeCronForTask(task, cronServiceRef);
              if (task.reminder) task.reminder.cronJobId = undefined;
            }

            // Reschedule if task is still open with a reminder
            if (task.status === "open" && task.dueAt && task.reminder && needsReschedule) {
              log?.info(
                `[task-manager] task_update tool: rescheduling cron for task ${task.id} at ${task.dueAt}`,
              );
              try {
                const cronJobId = await scheduleCronForTask(task, cronServiceRef);
                if (cronJobId && task.reminder) {
                  task.reminder.cronJobId = cronJobId;
                  log?.info(
                    `[task-manager] task_update tool: rescheduled cron ${cronJobId} for task ${task.id}`,
                  );
                }
              } catch (err) {
                log?.error(
                  `[task-manager] task_update tool: failed to reschedule cron for task ${task.id}: ${err}`,
                );
              }
            }
          } else {
            log?.warn(
              `[task-manager] task_update tool: cronServiceRef is null, cron changes deferred to sync interval`,
            );
          }

          await saveTasks(store);

          const check =
            task.status === "archived" ? "[archived]" : task.status === "done" ? "[x]" : "[ ]";
          let text = `Task updated: ${check} "${task.title}" (${task.id})`;
          if (task.dueDate) text += ` — due ${task.dueDate}`;
          if (task.dueAt && task.reminder)
            text += ` — reminder: ${task.reminder.action} at ${task.dueAt}`;
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

    api.registerGatewayMethod("tasks.list", async ({ params, respond, context }) => {
      try {
        const hadRef = !!cronServiceRef;
        if (!cronServiceRef && context?.cron) {
          cronServiceRef = context.cron as any;
          log?.info(
            `[task-manager] tasks.list: captured cronServiceRef from context.cron (was null)`,
          );
        }
        if (!hadRef && cronServiceRef) {
          log?.info(
            `[task-manager] tasks.list: cronServiceRef is now available — sync interval can schedule cron jobs`,
          );
        }
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

    api.registerGatewayMethod("tasks.add", async ({ params, respond, context }) => {
      try {
        if (!cronServiceRef && context?.cron) {
          cronServiceRef = context.cron as any;
          log?.info(`[task-manager] tasks.add: captured cronServiceRef`);
        }
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
          | { action?: string; channel?: string; note?: string }
          | undefined;
        const reminder: TaskReminder | undefined =
          reminderParam?.action === "call" || reminderParam?.action === "message"
            ? {
                action: reminderParam.action,
                channel:
                  typeof reminderParam.channel === "string"
                    ? reminderParam.channel.trim() || undefined
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

        // Schedule cron job if reminder is set
        if (dueAt && reminder) {
          log?.info(
            `[task-manager] tasks.add gateway: task ${task.id} has reminder, context.cron=${context?.cron ? "available" : "null"}`,
          );
          if (context?.cron) {
            try {
              const cronJobId = await scheduleCronForTask(task, context.cron as any);
              if (cronJobId && task.reminder) {
                task.reminder.cronJobId = cronJobId;
                log?.info(
                  `[task-manager] tasks.add gateway: cron ${cronJobId} scheduled for task ${task.id}`,
                );
              }
            } catch (err) {
              log?.error(
                `[task-manager] tasks.add gateway: failed to schedule cron for task ${task.id}: ${err}`,
              );
            }
          }
        }

        await saveTasks(store);
        respond(true, { task });
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });

    api.registerGatewayMethod("tasks.update", async ({ params, respond, context }) => {
      try {
        if (!cronServiceRef && context?.cron) {
          cronServiceRef = context.cron as any;
          log?.info(`[task-manager] tasks.update: captured cronServiceRef`);
        }
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

        const newDueAt =
          typeof params?.dueAt === "string" ? params.dueAt.trim() || undefined : undefined;
        const newAssignee =
          typeof params?.assignee === "string" ? params.assignee.trim() || undefined : undefined;
        const reminderParam = params?.reminder as
          | { action?: string; channel?: string; note?: string }
          | undefined;
        const newReminder: TaskReminder | undefined =
          reminderParam?.action === "call" || reminderParam?.action === "message"
            ? {
                action: reminderParam.action,
                channel:
                  typeof reminderParam.channel === "string"
                    ? reminderParam.channel.trim() || undefined
                    : undefined,
                note:
                  typeof reminderParam.note === "string"
                    ? reminderParam.note.trim() || undefined
                    : undefined,
                cronJobId: task.reminder?.cronJobId,
              }
            : undefined;

        const needsReschedule =
          (params?.dueAt !== undefined && newDueAt !== task.dueAt) || reminderParam !== undefined;

        if (typeof params?.title === "string") task.title = params.title.trim();
        if (typeof params?.notes === "string") task.notes = params.notes.trim() || undefined;
        if (typeof params?.dueDate === "string") task.dueDate = params.dueDate.trim() || undefined;
        if (params?.dueAt !== undefined) task.dueAt = newDueAt;
        if (params?.assignee !== undefined) task.assignee = newAssignee;
        if (newReminder !== undefined) task.reminder = newReminder;
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

        // Handle cron rescheduling
        const cron = context?.cron as any;
        if (cron) {
          const shouldRemoveCron =
            task.status === "done" || task.status === "archived" || needsReschedule;

          if (shouldRemoveCron) {
            log?.info(
              `[task-manager] tasks.update: removing cron for task ${task.id} (status=${task.status}, needsReschedule=${needsReschedule})`,
            );
            await removeCronForTask(task, cron);
            if (task.reminder) task.reminder.cronJobId = undefined;
          }

          if (task.status === "open" && task.dueAt && task.reminder && needsReschedule) {
            log?.info(
              `[task-manager] tasks.update: rescheduling cron for task ${task.id} at ${task.dueAt}`,
            );
            try {
              const cronJobId = await scheduleCronForTask(task, cron);
              if (cronJobId && task.reminder) {
                task.reminder.cronJobId = cronJobId;
                log?.info(
                  `[task-manager] tasks.update: rescheduled cron ${cronJobId} for task ${task.id}`,
                );
              }
            } catch (err) {
              log?.error(
                `[task-manager] tasks.update: failed to reschedule cron for task ${task.id}: ${err}`,
              );
            }
          }
        } else {
          log?.warn(`[task-manager] tasks.update: context.cron not available for task ${task.id}`);
        }

        await saveTasks(store);
        respond(true, { task });
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });

    api.registerGatewayMethod("tasks.remove", async ({ params, respond, context }) => {
      try {
        if (!cronServiceRef && context?.cron) {
          cronServiceRef = context.cron as any;
          log?.info(`[task-manager] tasks.remove: captured cronServiceRef`);
        }
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

        // Clean up cron job
        const cron = context?.cron as any;
        if (cron && removed.reminder?.cronJobId) {
          log?.info(`[task-manager] tasks.remove: cleaning up cron for removed task ${removed.id}`);
          await removeCronForTask(removed, cron);
        }

        await saveTasks(store);
        respond(true, { id, title: removed.title });
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });

    api.registerGatewayMethod("tasks.archiveDone", async ({ respond, context }) => {
      if (!cronServiceRef && context?.cron) {
        cronServiceRef = context.cron as any;
        log?.info(`[task-manager] tasks.archiveDone: captured cronServiceRef`);
      }
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
    // Service (captures workspaceDir at startup)
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
        ctx.logger.info(
          "task-manager: service started, cronServiceRef will be populated on first gateway method call (e.g. tasks.list from UI connect)",
        );

        // Cron sync interval — picks up tasks with reminder + dueAt but no cronJobId
        // Runs every 5s so tasks created via agent tools get scheduled quickly
        const syncInterval = setInterval(async () => {
          if (!cronServiceRef) {
            // Don't log every 5s — only on first check
            return;
          }
          try {
            const store = await loadTasks();
            let dirty = false;
            for (const task of store.tasks) {
              if (
                task.status === "open" &&
                task.dueAt &&
                task.reminder &&
                !task.reminder.cronJobId
              ) {
                ctx.logger.info(
                  `task-manager: sync interval found unscheduled task ${task.id} "${task.title}" — scheduling cron`,
                );
                try {
                  const cronJobId = await scheduleCronForTask(task, cronServiceRef!);
                  if (cronJobId) {
                    task.reminder.cronJobId = cronJobId;
                    dirty = true;
                    ctx.logger.info(
                      `task-manager: sync interval scheduled cron ${cronJobId} for task ${task.id}`,
                    );
                  }
                } catch (err) {
                  ctx.logger.warn(
                    `task-manager: sync interval failed to schedule cron for task ${task.id}: ${err}`,
                  );
                }
              }
            }
            if (dirty) await saveTasks(store);
          } catch (err) {
            ctx.logger.warn(`task-manager: sync interval error: ${err}`);
          }
        }, 5_000);

        // Clean up on process exit
        const cleanup = () => clearInterval(syncInterval);
        process.once("SIGTERM", cleanup);
        process.once("SIGINT", cleanup);
      },
    });
  },
};
