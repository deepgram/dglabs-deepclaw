import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.ts";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
import { renderCron, type CronProps } from "./cron.ts";

function createJob(id: string): CronJob {
  return {
    id,
    name: "Daily ping",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
  };
}

function createProps(overrides: Partial<CronProps> = {}): CronProps {
  return {
    basePath: "",
    loading: false,
    status: null,
    jobs: [],
    error: null,
    busy: false,
    form: { ...DEFAULT_CRON_FORM },
    channels: [],
    channelLabels: {},
    runsJobId: null,
    runs: [],
    editingJobId: null,
    formOpen: false,
    onFormChange: () => undefined,
    onRefresh: () => undefined,
    onNewJob: () => undefined,
    onAdd: () => undefined,
    onSave: () => undefined,
    onEdit: () => undefined,
    onCancelEdit: () => undefined,
    onToggle: () => undefined,
    onRun: () => undefined,
    onRemove: () => undefined,
    onLoadRuns: () => undefined,
    ...overrides,
  };
}

describe("cron view", () => {
  it("hides the form by default and shows New Job button", () => {
    const container = document.createElement("div");
    render(renderCron(createProps()), container);

    expect(container.querySelector(".card-title")?.textContent).not.toBe("New Job");
    const newJobBtn = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "New Job",
    );
    expect(newJobBtn).not.toBeUndefined();
  });

  it("shows the New Job form when formOpen is true", () => {
    const container = document.createElement("div");
    render(renderCron(createProps({ formOpen: true })), container);

    const titles = Array.from(container.querySelectorAll(".card-title")).map((el) =>
      (el.textContent ?? "").trim(),
    );
    expect(titles).toContain("New Job");
  });

  it("loads run history when clicking a job row", () => {
    const container = document.createElement("div");
    const onLoadRuns = vi.fn();
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          onLoadRuns,
        }),
      ),
      container,
    );

    const row = container.querySelector(".list-item-clickable");
    expect(row).not.toBeNull();
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onLoadRuns).toHaveBeenCalledWith("job-1");
  });

  it("marks the selected job with list-item-selected class", () => {
    const container = document.createElement("div");
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          runsJobId: "job-1",
        }),
      ),
      container,
    );

    const selected = container.querySelector(".list-item-selected");
    expect(selected).not.toBeNull();
  });

  it("renders run chat links when session keys are present", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          basePath: "/ui",
          jobs: [createJob("job-1")],
          runsJobId: "job-1",
          runs: [
            {
              ts: Date.now(),
              jobId: "job-1",
              status: "ok",
              summary: "done",
              sessionKey: "agent:main:cron:job-1:run:abc",
            },
          ],
        }),
      ),
      container,
    );

    const link = container.querySelector("a.session-link");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toContain(
      "/ui/chat?session=agent%3Amain%3Acron%3Ajob-1%3Arun%3Aabc",
    );
  });

  it("shows inline run history inside the selected job card sorted newest first", () => {
    const container = document.createElement("div");
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          runsJobId: "job-1",
          runs: [
            { ts: 1, jobId: "job-1", status: "ok", summary: "older run" },
            { ts: 2, jobId: "job-1", status: "ok", summary: "newer run" },
          ],
        }),
      ),
      container,
    );

    const runsSection = container.querySelector(".cron-job-runs");
    expect(runsSection).not.toBeNull();

    const summaries = Array.from(runsSection?.querySelectorAll(".list-item .list-sub") ?? []).map(
      (el) => (el.textContent ?? "").trim(),
    );
    expect(summaries[0]).toBe("newer run");
    expect(summaries[1]).toBe("older run");
  });

  it("shows remove confirmation dialog", () => {
    const container = document.createElement("div");
    const onRemove = vi.fn();
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          onRemove,
        }),
      ),
      container,
    );

    // Stub window.confirm to return false
    const original = window.confirm;
    window.confirm = vi.fn(() => false);

    const removeButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Remove",
    );
    expect(removeButton).not.toBeUndefined();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(window.confirm).toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();

    window.confirm = original;
  });

  it("shows human-friendly chip labels", () => {
    const container = document.createElement("div");
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
        }),
      ),
      container,
    );

    const chips = Array.from(container.querySelectorAll(".cron-job-chips .chip")).map((el) =>
      (el.textContent ?? "").trim(),
    );
    expect(chips).toContain("Main session");
    expect(chips).toContain("Next heartbeat");
  });

  it("shows Edit Job title when editing", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          editingJobId: "job-1",
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Edit Job");
    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Save",
    );
    expect(saveButton).not.toBeUndefined();
    const cancelButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Cancel",
    );
    expect(cancelButton).not.toBeUndefined();
  });

  it("renders compact status bar", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          status: { enabled: true, jobs: 3, nextWakeAtMs: Date.now() + 720_000 },
        }),
      ),
      container,
    );

    const bar = container.querySelector(".cron-status-bar");
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain("Active");
    expect(bar?.textContent).toContain("3 jobs");
  });
});
