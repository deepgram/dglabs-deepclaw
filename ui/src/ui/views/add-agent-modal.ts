import { html, nothing } from "lit";
import type { AddAgentFormState } from "../ui-types.ts";
import { renderEmojiPicker } from "./emoji-picker.ts";

export type AddAgentModalProps = {
  open: boolean;
  form: AddAgentFormState;
  busy: boolean;
  error: string | null;
  onFormChange: (patch: Partial<AddAgentFormState>) => void;
  onSubmit: () => void;
  onClose: () => void;
};

const DEEPGRAM_VOICES = [
  { value: "aura-2-thalia-en", label: "Thalia (English)" },
  { value: "aura-2-andromeda-en", label: "Andromeda (English)" },
  { value: "aura-2-arcas-en", label: "Arcas (English)" },
  { value: "aura-2-atlas-en", label: "Atlas (English)" },
  { value: "aura-2-luna-en", label: "Luna (English)" },
  { value: "aura-2-helios-en", label: "Helios (English)" },
  { value: "aura-2-zeus-en", label: "Zeus (English)" },
  { value: "aura-2-orpheus-en", label: "Orpheus (English)" },
  { value: "aura-2-asteria-en", label: "Asteria (English)" },
  { value: "aura-2-stella-en", label: "Stella (English)" },
  { value: "aura-2-hera-en", label: "Hera (English)" },
  { value: "aura-2-athena-en", label: "Athena (English)" },
] as const;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function renderAddAgentModal(props: AddAgentModalProps) {
  if (!props.open) {
    return nothing;
  }
  const { form, busy } = props;
  const isVoice = form.agentType === "voice";
  const placeholderWorkspace = form.name.trim()
    ? `~/.openclaw/workspace/${slugify(form.name)}`
    : "~/.openclaw/workspace/<agent-name>";

  return html`
    <div
      class="exec-approval-overlay"
      role="dialog"
      aria-modal="true"
      @click=${(e: Event) => {
        if ((e.target as HTMLElement).classList.contains("exec-approval-overlay")) {
          props.onClose();
        }
      }}
    >
      <div class="exec-approval-card" style="max-width: 520px;">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">Add Agent</div>
            <div class="exec-approval-sub">Create a new agent workspace.</div>
          </div>
        </div>

        <div style="margin-top: 16px; display: flex; gap: 8px;">
          <button
            class="btn btn--sm ${!isVoice ? "active" : ""}"
            type="button"
            @click=${() => props.onFormChange({ agentType: "text" })}
            ?disabled=${busy}
          >
            Text
          </button>
          <button
            class="btn btn--sm ${isVoice ? "active" : ""}"
            type="button"
            @click=${() => props.onFormChange({ agentType: "voice" })}
            ?disabled=${busy}
          >
            Voice
          </button>
        </div>

        <label class="field" style="margin-top: 14px;">
          <span>Name *</span>
          <input
            .value=${form.name}
            @input=${(e: Event) =>
              props.onFormChange({ name: (e.target as HTMLInputElement).value })}
            ?disabled=${busy}
            placeholder="My Agent"
          />
        </label>

        <div class="field" style="margin-top: 10px;">
          <span>Emoji</span>
          <div style="margin-top: 6px;">
            ${renderEmojiPicker({
              selected: form.emoji,
              disabled: busy,
              onSelect: (emoji) => props.onFormChange({ emoji }),
            })}
          </div>
        </div>

        <label class="field" style="margin-top: 10px;">
          <span>Workspace</span>
          <input
            .value=${form.workspace}
            @input=${(e: Event) =>
              props.onFormChange({ workspace: (e.target as HTMLInputElement).value })}
            ?disabled=${busy}
            placeholder=${placeholderWorkspace}
          />
        </label>

        ${
          isVoice
            ? html`
              <label class="field" style="margin-top: 10px;">
                <span>Voice Model</span>
                <select
                  .value=${form.voice}
                  @change=${(e: Event) =>
                    props.onFormChange({ voice: (e.target as HTMLSelectElement).value })}
                  ?disabled=${busy}
                >
                  ${DEEPGRAM_VOICES.map((v) => html`<option value=${v.value}>${v.label}</option>`)}
                </select>
              </label>

              <label class="field" style="margin-top: 10px;">
                <span>Greeting</span>
                <input
                  .value=${form.greeting}
                  @input=${(e: Event) =>
                    props.onFormChange({
                      greeting: (e.target as HTMLInputElement).value,
                    })}
                  ?disabled=${busy}
                  placeholder="Hello! How can I help you today?"
                />
              </label>
            `
            : nothing
        }

        ${
          props.error
            ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
            : nothing
        }

        <div class="exec-approval-actions" style="margin-top: 16px;">
          <button
            class="btn primary"
            ?disabled=${busy || !form.name.trim()}
            @click=${props.onSubmit}
          >
            ${busy ? "Creating…" : "Create"}
          </button>
          <button class="btn" ?disabled=${busy} @click=${props.onClose}>Cancel</button>
        </div>
      </div>
    </div>
  `;
}
