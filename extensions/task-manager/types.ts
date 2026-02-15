export interface TaskReminder {
  action: "call" | "message";
  /** Recipient phone number in E.164 format. Falls back to ownerPhone from plugin config. */
  to?: string;
  note?: string;
  /** Set to true after delivery succeeds (or permanently fails). */
  delivered?: boolean;
  /** Error message if delivery failed permanently. */
  deliveryError?: string;
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
