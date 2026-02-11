import { html, nothing } from "lit";
import type { SkillMessageMap } from "../controllers/skills.ts";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";
import { clampText } from "../format.ts";

type SkillGroup = {
  id: string;
  label: string;
  skills: SkillStatusEntry[];
};

const SKILL_SOURCE_GROUPS: Array<{ id: string; label: string; sources: string[] }> = [
  { id: "workspace", label: "Workspace Skills", sources: ["openclaw-workspace"] },
  { id: "built-in", label: "Built-in Skills", sources: ["openclaw-bundled"] },
  { id: "installed", label: "Installed Skills", sources: ["openclaw-managed"] },
  { id: "extra", label: "Extra Skills", sources: ["openclaw-extra"] },
];

function groupSkills(skills: SkillStatusEntry[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const def of SKILL_SOURCE_GROUPS) {
    groups.set(def.id, { id: def.id, label: def.label, skills: [] });
  }
  const builtInGroup = SKILL_SOURCE_GROUPS.find((group) => group.id === "built-in");
  const other: SkillGroup = { id: "other", label: "Other Skills", skills: [] };
  for (const skill of skills) {
    const match = skill.bundled
      ? builtInGroup
      : SKILL_SOURCE_GROUPS.find((group) => group.sources.includes(skill.source));
    if (match) {
      groups.get(match.id)?.skills.push(skill);
    } else {
      other.skills.push(skill);
    }
  }
  const ordered = SKILL_SOURCE_GROUPS.map((group) => groups.get(group.id)).filter(
    (group): group is SkillGroup => Boolean(group && group.skills.length > 0),
  );
  if (other.skills.length > 0) {
    ordered.push(other);
  }
  return ordered;
}

export type SkillsProps = {
  loading: boolean;
  report: SkillStatusReport | null;
  error: string | null;
  filter: string;
  edits: Record<string, string>;
  busyKey: string | null;
  messages: SkillMessageMap;
  onFilterChange: (next: string) => void;
  onRefresh: () => void;
  onToggle: (skillKey: string, enabled: boolean) => void;
  onEdit: (skillKey: string, value: string) => void;
  onSaveKey: (skillKey: string) => void;
  onInstall: (skillKey: string, name: string, installId: string) => void;
};

export function renderSkills(props: SkillsProps) {
  const skills = props.report?.skills ?? [];
  const filter = props.filter.trim().toLowerCase();
  const filtered = filter
    ? skills.filter((skill) =>
        [skill.name, skill.description, skill.source].join(" ").toLowerCase().includes(filter),
      )
    : skills;
  const groups = groupSkills(filtered);

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Skills</div>
          <div class="card-sub">Bundled, managed, and workspace skills.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="flex: 1;">
          <span>Filter</span>
          <input
            .value=${props.filter}
            @input=${(e: Event) => props.onFilterChange((e.target as HTMLInputElement).value)}
            placeholder="Search skills"
          />
        </label>
        <div class="muted">${filtered.length} shown</div>
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }

      ${
        filtered.length === 0
          ? html`
              <div class="muted" style="margin-top: 16px">No skills found.</div>
            `
          : html`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${groups.map((group) => {
                const collapsedByDefault = group.id === "workspace" || group.id === "built-in";
                return html`
                  <details class="agent-skills-group" ?open=${!collapsedByDefault}>
                    <summary class="agent-skills-header">
                      <span>${group.label}</span>
                      <span class="muted">${group.skills.length}</span>
                    </summary>
                    <div class="skill-list">
                      ${group.skills.map((skill) => renderSkill(skill, props))}
                    </div>
                  </details>
                `;
              })}
            </div>
          `
      }
    </section>
  `;
}

function abbreviateSource(source: string): string {
  return source.replace(/^openclaw-/, "");
}

function renderSkill(skill: SkillStatusEntry, props: SkillsProps) {
  const busy = props.busyKey === skill.skillKey;
  const apiKey = props.edits[skill.skillKey] ?? "";
  const message = props.messages[skill.skillKey] ?? null;
  const canInstall = skill.install.length > 0 && skill.missing.bins.length > 0;
  const showBundledBadge = Boolean(skill.bundled && skill.source !== "openclaw-bundled");
  const missing = [
    ...skill.missing.bins.map((b) => `bin:${b}`),
    ...skill.missing.env.map((e) => `env:${e}`),
    ...skill.missing.config.map((c) => `config:${c}`),
    ...skill.missing.os.map((o) => `os:${o}`),
  ];
  const reasons: string[] = [];
  if (skill.disabled) {
    reasons.push("disabled");
  }
  if (skill.blockedByAllowlist) {
    reasons.push("blocked by allowlist");
  }
  const hasExtra = Boolean(skill.primaryEnv) || canInstall;

  return html`
    <div class="skill-row">
      <div class="skill-row__name">
        ${skill.emoji ? `${skill.emoji} ` : ""}${skill.name}
      </div>
      <div class="skill-row__desc">${clampText(skill.description, 80)}</div>
      <div class="skill-row__chips">
        <span class="chip">${abbreviateSource(skill.source)}</span>
        ${
          showBundledBadge
            ? html`
                <span class="chip">bundled</span>
              `
            : nothing
        }
        <span
          class="chip ${skill.eligible ? "chip-ok" : "chip-warn"}"
          title=${missing.length > 0 ? `Missing: ${missing.join(", ")}` : ""}
        >
          ${skill.eligible ? "eligible" : "blocked"}
        </span>
        ${
          skill.disabled
            ? html`<span
                class="chip chip-warn"
                title=${reasons.length > 0 ? reasons.join(", ") : ""}
              >disabled</span>`
            : nothing
        }
      </div>
      <div class="skill-row__actions">
        <button
          class="btn btn--sm"
          ?disabled=${busy}
          @click=${() => props.onToggle(skill.skillKey, skill.disabled)}
        >
          ${skill.disabled ? "Enable" : "Disable"}
        </button>
      </div>
    </div>
    ${
      message
        ? html`<div class="skill-row__extra">
            <span style="color: ${
              message.kind === "error"
                ? "var(--danger-color, #d14343)"
                : "var(--success-color, #0a7f5a)"
            }; font-size: 12px;">
              ${message.message}
            </span>
          </div>`
        : nothing
    }
    ${
      hasExtra
        ? html`<div class="skill-row__extra">
            ${
              canInstall
                ? html`<button
                    class="btn btn--sm"
                    ?disabled=${busy}
                    @click=${() => props.onInstall(skill.skillKey, skill.name, skill.install[0].id)}
                  >
                    ${busy ? "Installing…" : skill.install[0].label}
                  </button>`
                : nothing
            }
            ${
              skill.primaryEnv
                ? html`
                    <label class="field" style="flex: 1; min-width: 160px;">
                      <span>API key</span>
                      <input
                        type="password"
                        .value=${apiKey}
                        @input=${(e: Event) =>
                          props.onEdit(skill.skillKey, (e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <button
                      class="btn btn--sm primary"
                      ?disabled=${busy}
                      @click=${() => props.onSaveKey(skill.skillKey)}
                    >
                      Save key
                    </button>
                  `
                : nothing
            }
          </div>`
        : nothing
    }
  `;
}
