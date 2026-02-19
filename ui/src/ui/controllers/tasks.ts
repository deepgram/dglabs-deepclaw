import type { GatewayBrowserClient } from "../gateway.ts";
import type { TaskItem } from "../types.ts";
import type { TaskFormState } from "../ui-types.ts";
import { DEFAULT_TASK_FORM } from "../app-defaults.ts";

export type TasksState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  tasksLoading: boolean;
  tasksList: TaskItem[];
  tasksError: string | null;
  tasksForm: TaskFormState;
  tasksBusy: boolean;
  tasksEditingId: string | null;
  tasksFormOpen: boolean;
  tasksFilter: "open" | "done" | "archived" | "all";
};

export async function loadTasksList(state: TasksState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.tasksLoading) {
    return;
  }
  state.tasksLoading = true;
  state.tasksError = null;
  try {
    const res = await state.client.request<{ tasks?: TaskItem[] }>("tasks.list", {
      status: "everything",
    });
    state.tasksList = Array.isArray(res.tasks) ? res.tasks : [];
  } catch (err) {
    state.tasksError = String(err);
  } finally {
    state.tasksLoading = false;
  }
}

export async function addTask(state: TasksState) {
  if (!state.client || !state.connected || state.tasksBusy) {
    return;
  }
  const title = state.tasksForm.title.trim();
  if (!title) {
    state.tasksError = "Title is required.";
    return;
  }
  state.tasksBusy = true;
  state.tasksError = null;
  try {
    const params: Record<string, unknown> = {
      title,
      notes: state.tasksForm.notes.trim() || undefined,
      dueDate: state.tasksForm.dueDate.trim() || undefined,
      dueAt: state.tasksForm.dueAt.trim() || undefined,
      assignee: state.tasksForm.assignee.trim() || undefined,
    };
    if (state.tasksForm.reminderAction === "call" || state.tasksForm.reminderAction === "message") {
      params.reminder = {
        action: state.tasksForm.reminderAction,
        channel: state.tasksForm.reminderChannel.trim() || undefined,
        note: state.tasksForm.reminderNote.trim() || undefined,
      };
    }
    await state.client.request("tasks.add", params);
    state.tasksForm = { ...DEFAULT_TASK_FORM };
    await loadTasksList(state);
  } catch (err) {
    state.tasksError = String(err);
  } finally {
    state.tasksBusy = false;
  }
}

export async function updateTask(state: TasksState) {
  if (!state.client || !state.connected || state.tasksBusy || !state.tasksEditingId) {
    return;
  }
  const title = state.tasksForm.title.trim();
  if (!title) {
    state.tasksError = "Title is required.";
    return;
  }
  state.tasksBusy = true;
  state.tasksError = null;
  try {
    const params: Record<string, unknown> = {
      id: state.tasksEditingId,
      title,
      notes: state.tasksForm.notes.trim() || undefined,
      dueDate: state.tasksForm.dueDate.trim() || undefined,
      dueAt: state.tasksForm.dueAt.trim() || undefined,
      assignee: state.tasksForm.assignee.trim() || undefined,
    };
    if (state.tasksForm.reminderAction === "call" || state.tasksForm.reminderAction === "message") {
      params.reminder = {
        action: state.tasksForm.reminderAction,
        channel: state.tasksForm.reminderChannel.trim() || undefined,
        note: state.tasksForm.reminderNote.trim() || undefined,
      };
    }
    await state.client.request("tasks.update", params);
    state.tasksEditingId = null;
    state.tasksForm = { ...DEFAULT_TASK_FORM };
    await loadTasksList(state);
  } catch (err) {
    state.tasksError = String(err);
  } finally {
    state.tasksBusy = false;
  }
}

export async function toggleTaskStatus(state: TasksState, task: TaskItem, status: "open" | "done") {
  if (!state.client || !state.connected || state.tasksBusy) {
    return;
  }
  state.tasksBusy = true;
  state.tasksError = null;
  try {
    await state.client.request("tasks.update", { id: task.id, status });
    await loadTasksList(state);
  } catch (err) {
    state.tasksError = String(err);
  } finally {
    state.tasksBusy = false;
  }
}

export async function removeTask(state: TasksState, task: TaskItem) {
  if (!state.client || !state.connected || state.tasksBusy) {
    return;
  }
  state.tasksBusy = true;
  state.tasksError = null;
  try {
    await state.client.request("tasks.remove", { id: task.id });
    await loadTasksList(state);
  } catch (err) {
    state.tasksError = String(err);
  } finally {
    state.tasksBusy = false;
  }
}

export async function archiveDoneTask(state: TasksState, task: TaskItem) {
  if (!state.client || !state.connected || state.tasksBusy) {
    return;
  }
  state.tasksBusy = true;
  state.tasksError = null;
  try {
    await state.client.request("tasks.update", { id: task.id, status: "archived" });
    await loadTasksList(state);
  } catch (err) {
    state.tasksError = String(err);
  } finally {
    state.tasksBusy = false;
  }
}

export async function archiveAllDone(state: TasksState) {
  if (!state.client || !state.connected || state.tasksBusy) {
    return;
  }
  state.tasksBusy = true;
  state.tasksError = null;
  try {
    await state.client.request("tasks.archiveDone", {});
    await loadTasksList(state);
  } catch (err) {
    state.tasksError = String(err);
  } finally {
    state.tasksBusy = false;
  }
}

export function taskToForm(task: TaskItem): TaskFormState {
  return {
    title: task.title,
    notes: task.notes ?? "",
    dueDate: task.dueDate ?? "",
    dueAt: task.dueAt ?? "",
    assignee: task.assignee ?? "",
    reminderAction: task.reminder?.action ?? "",
    reminderChannel: task.reminder?.channel ?? "",
    reminderNote: task.reminder?.note ?? "",
  };
}
