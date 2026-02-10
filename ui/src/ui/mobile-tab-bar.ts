import { html, nothing } from "lit";
import type { AppViewState } from "./app-view-state.ts";
import type { Tab } from "./navigation.ts";
import { icons } from "./icons.ts";
import { MOBILE_PRIMARY_TABS, TAB_GROUPS, iconForTab, titleForTab } from "./navigation.ts";

export function renderMobileTabBar(
  state: AppViewState,
  moreOpen: boolean,
  onToggleMore: () => void,
) {
  const isPrimaryTab = MOBILE_PRIMARY_TABS.includes(state.tab);

  return html`
    <nav class="mobile-tab-bar" aria-label="Mobile navigation">
      ${MOBILE_PRIMARY_TABS.map(
        (tab) => html`
          <button
            class="mobile-tab-bar__tab ${state.tab === tab ? "mobile-tab-bar__tab--active" : ""}"
            @click=${() => {
              state.setTab(tab);
              if (moreOpen) {
                onToggleMore();
              }
            }}
            aria-current=${state.tab === tab ? "page" : "false"}
          >
            <span class="mobile-tab-bar__icon">${icons[iconForTab(tab)]}</span>
            <span class="mobile-tab-bar__label">${titleForTab(tab)}</span>
          </button>
        `,
      )}
      <button
        class="mobile-tab-bar__tab mobile-tab-bar__tab--more ${moreOpen ? "mobile-tab-bar__tab--active" : ""}"
        @click=${onToggleMore}
        aria-expanded=${moreOpen}
      >
        <span class="mobile-tab-bar__icon">${icons.grid}</span>
        <span class="mobile-tab-bar__label">More</span>
        ${
          !isPrimaryTab
            ? html`
                <span class="mobile-tab-bar__dot"></span>
              `
            : nothing
        }
      </button>
    </nav>

    ${
      moreOpen
        ? html`
          <div class="mobile-more-backdrop" @click=${onToggleMore}></div>
          <div class="mobile-more-sheet">
            ${TAB_GROUPS.filter((group) =>
              group.tabs.some((tab) => !MOBILE_PRIMARY_TABS.includes(tab as Tab)),
            ).map(
              (group) => html`
                <div class="mobile-more-sheet__group">
                  <div class="mobile-more-sheet__group-label">${group.label}</div>
                  <div class="mobile-more-sheet__group-items">
                    ${group.tabs
                      .filter((tab) => !MOBILE_PRIMARY_TABS.includes(tab as Tab))
                      .map(
                        (tab) => html`
                          <button
                            class="mobile-more-sheet__item ${state.tab === (tab as Tab) ? "mobile-more-sheet__item--active" : ""}"
                            @click=${() => {
                              state.setTab(tab as Tab);
                              onToggleMore();
                            }}
                          >
                            <span class="mobile-tab-bar__icon">${icons[iconForTab(tab as Tab)]}</span>
                            <span>${titleForTab(tab as Tab)}</span>
                          </button>
                        `,
                      )}
                  </div>
                </div>
              `,
            )}
          </div>
        `
        : nothing
    }
  `;
}
