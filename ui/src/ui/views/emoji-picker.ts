import { html } from "lit";

export const EMOJI_OPTIONS = [
  "\u{1F916}", // robot
  "\u{1F9E0}", // brain
  "\u{2728}", // sparkles
  "\u{1F680}", // rocket
  "\u{1F4AC}", // speech balloon
  "\u{1F50D}", // magnifying glass
  "\u{1F4A1}", // light bulb
  "\u{1F3AF}", // direct hit
  "\u{1F525}", // fire
  "\u{26A1}", // zap
  "\u{1F4DD}", // memo
  "\u{1F6E0}\u{FE0F}", // wrench
  "\u{1F331}", // seedling
  "\u{1F30D}", // globe
  "\u{1F4E1}", // satellite antenna
  "\u{1F399}\u{FE0F}", // studio microphone
  "\u{1F3B5}", // musical note
  "\u{1F440}", // eyes
  "\u{1F47E}", // alien monster
  "\u{1F98A}", // fox
  "\u{1F43B}", // bear
  "\u{1F431}", // cat
  "\u{1F436}", // dog
  "\u{1F985}", // eagle
];

export function renderEmojiPicker(props: {
  selected: string;
  disabled: boolean;
  onSelect: (emoji: string) => void;
}) {
  return html`
    <div style="display: flex; flex-wrap: wrap; gap: 4px;">
      ${EMOJI_OPTIONS.map(
        (e) => html`
          <button
            type="button"
            style="
              font-size: 20px;
              width: 36px;
              height: 36px;
              display: flex;
              align-items: center;
              justify-content: center;
              border-radius: 6px;
              border: 2px solid ${props.selected === e ? "var(--accent, #3cffd0)" : "transparent"};
              background: ${props.selected === e ? "rgba(60,255,208,0.12)" : "var(--bg-secondary, rgba(255,255,255,0.06))"};
              cursor: pointer;
              padding: 0;
              transition: border-color 0.15s, background 0.15s;
            "
            ?disabled=${props.disabled}
            @click=${() => props.onSelect(props.selected === e ? "" : e)}
            title=${e}
          >${e}</button>
        `,
      )}
    </div>
  `;
}
