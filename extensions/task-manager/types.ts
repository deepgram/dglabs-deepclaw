export interface TaskReminder {
  action: "call" | "message";
  channel?: string;
  note?: string;
  cronJobId?: string;
}

export interface Task {
  id: string;
  title: string;
  status: "open" | "done" | "archived";
  notes?: string;
  dueDate?: string;
  dueAt?: string;
  assignee?: string;
  reminder?: TaskReminder;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStore {
  tasks: Task[];
}
