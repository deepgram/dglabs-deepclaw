import { html, nothing } from "lit";
import type { MemoryFileEntry, MemoryFilesListResult } from "../types.ts";
import { formatRelativeTimestamp } from "../format.ts";

export type MemoryProps = {
  loading: boolean;
  error: string | null;
  filesList: MemoryFilesListResult | null;
  fileActive: string | null;
  fileContents: Record<string, string>;
  fileDrafts: Record<string, string>;
  saving: boolean;
  onRefresh: () => void;
  onSelectFile: (name: string) => void;
  onFileDraftChange: (name: string, content: string) => void;
  onFileReset: (name: string) => void;
  onFileSave: (name: string) => void;
};

function formatBytes(bytes?: number) {
  if (bytes == null || !Number.isFinite(bytes)) {
    return "-";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function renderMemoryFileRow(file: MemoryFileEntry, active: string | null, onSelect: () => void) {
  const status = `${formatBytes(file.size)} · ${formatRelativeTimestamp(file.updatedAtMs ?? null)}`;
  return html`
		<button
			type="button"
			class="agent-file-row ${active === file.name ? "active" : ""}"
			@click=${onSelect}
		>
			<div>
				<div class="agent-file-name mono">${file.name}</div>
				<div class="agent-file-meta">${status}</div>
			</div>
			${
        file.pinned
          ? html`
              <span class="agent-pill">pinned</span>
            `
          : nothing
      }
		</button>
	`;
}

export function renderMemory(props: MemoryProps) {
  const files = props.filesList?.files ?? [];
  const active = props.fileActive ?? null;
  const activeEntry = active ? (files.find((file) => file.name === active) ?? null) : null;
  const baseContent = active ? (props.fileContents[active] ?? "") : "";
  const draft = active ? (props.fileDrafts[active] ?? baseContent) : "";
  const isDirty = active ? draft !== baseContent : false;

  return html`
		<section class="card">
			<div class="row" style="justify-content: space-between;">
				<div>
					<div class="card-title">Memory Files</div>
					<div class="card-sub">Daily logs and curated long-term memory.</div>
				</div>
				<button
					class="btn btn--sm"
					?disabled=${props.loading}
					@click=${props.onRefresh}
				>
					${props.loading ? "Loading\u2026" : "Refresh"}
				</button>
			</div>
			${props.filesList ? html`<div class="muted mono" style="margin-top: 8px;">Workspace: ${props.filesList.workspace}</div>` : nothing}
			${props.error ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>` : nothing}
			${
        !props.filesList
          ? html`
              <div class="callout info" style="margin-top: 12px">
                Load memory files to browse daily logs and MEMORY.md.
              </div>
            `
          : html`
							<div class="agent-files-grid" style="margin-top: 16px;">
								<div class="agent-files-list">
									${
                    files.length === 0
                      ? html`
                          <div class="muted">No memory files found.</div>
                        `
                      : files.map((file) =>
                          renderMemoryFileRow(file, active, () => props.onSelectFile(file.name)),
                        )
                  }
								</div>
								<div class="agent-files-editor">
									${
                    !activeEntry
                      ? html`
                          <div class="muted">Select a file to view or edit.</div>
                        `
                      : html`
													<div class="agent-file-header">
														<div>
															<div class="agent-file-title mono">${activeEntry.name}</div>
															<div class="agent-file-sub mono">${activeEntry.path}</div>
														</div>
														<div class="agent-file-actions">
															<button
																class="btn btn--sm"
																?disabled=${!isDirty}
																@click=${() => props.onFileReset(activeEntry.name)}
															>
																Reset
															</button>
															<button
																class="btn btn--sm primary"
																?disabled=${props.saving || !isDirty}
																@click=${() => props.onFileSave(activeEntry.name)}
															>
																${props.saving ? "Saving\u2026" : "Save"}
															</button>
														</div>
													</div>
													<label class="field" style="margin-top: 12px;">
														<span>Content</span>
														<textarea
															.value=${draft}
															@input=${(e: Event) =>
                                props.onFileDraftChange(
                                  activeEntry.name,
                                  (e.target as HTMLTextAreaElement).value,
                                )}
														></textarea>
													</label>
												`
                  }
								</div>
							</div>
						`
      }
		</section>
	`;
}
