import { html, nothing, type TemplateResult } from "lit";

export type MicPermissionModalProps = {
  open: boolean;
  onClose: () => void;
  onRetry: () => void;
};

type BrowserType = "chrome" | "safari" | "firefox" | "edge" | "other";

function detectBrowser(): BrowserType {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("edg/")) {
    return "edge";
  }
  if (ua.includes("chrome")) {
    return "chrome";
  }
  if (ua.includes("safari") && !ua.includes("chrome")) {
    return "safari";
  }
  if (ua.includes("firefox")) {
    return "firefox";
  }
  return "other";
}

function getBrowserInstructions(browser: BrowserType): TemplateResult {
  switch (browser) {
    case "chrome":
      return html`
        <ol class="dictation-permission-modal__steps">
          <li>Click the <strong>lock icon</strong> (or tune icon) in the address bar</li>
          <li>Find <strong>Microphone</strong> in the permissions list</li>
          <li>Change it to <strong>Allow</strong></li>
          <li>Refresh the page if prompted</li>
        </ol>
      `;
    case "safari":
      return html`
        <ol class="dictation-permission-modal__steps">
          <li>Go to <strong>Safari</strong> menu &rarr; <strong>Settings</strong></li>
          <li>Click the <strong>Websites</strong> tab</li>
          <li>Select <strong>Microphone</strong> from the left sidebar</li>
          <li>Find this website and set it to <strong>Allow</strong></li>
        </ol>
      `;
    case "firefox":
      return html`
        <ol class="dictation-permission-modal__steps">
          <li>Click the <strong>lock icon</strong> in the address bar</li>
          <li>Click <strong>Connection secure</strong></li>
          <li>Click <strong>More Information</strong></li>
          <li>Go to <strong>Permissions</strong> tab and allow Microphone</li>
        </ol>
      `;
    case "edge":
      return html`
        <ol class="dictation-permission-modal__steps">
          <li>Click the <strong>lock icon</strong> in the address bar</li>
          <li>Click <strong>Permissions for this site</strong></li>
          <li>Find <strong>Microphone</strong> and set it to <strong>Allow</strong></li>
          <li>Refresh the page if prompted</li>
        </ol>
      `;
    default:
      return html`
        <ol class="dictation-permission-modal__steps">
          <li>Open your browser settings</li>
          <li>Navigate to site permissions or privacy settings</li>
          <li>Find microphone permissions for this website</li>
          <li>Enable microphone access and refresh the page</li>
        </ol>
      `;
  }
}

function getBrowserName(browser: BrowserType): string {
  switch (browser) {
    case "chrome":
      return "Chrome";
    case "safari":
      return "Safari";
    case "firefox":
      return "Firefox";
    case "edge":
      return "Edge";
    default:
      return "your browser";
  }
}

export function renderMicPermissionModal(props: MicPermissionModalProps) {
  if (!props.open) {
    return nothing;
  }

  const browser = detectBrowser();
  const browserName = getBrowserName(browser);

  return html`
    <div
      class="exec-approval-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mic-permission-title"
      @click=${props.onClose}
    >
      <div
        class="exec-approval-card dictation-permission-modal"
        @click=${(e: Event) => e.stopPropagation()}
      >
        <div class="exec-approval-header">
          <div>
            <div id="mic-permission-title" class="exec-approval-title">
              Microphone Access Required
            </div>
            <div class="exec-approval-sub">
              Detected browser: ${browserName}
            </div>
          </div>
          <button
            class="btn btn--sm btn--icon"
            @click=${props.onClose}
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="dictation-permission-modal__content">
          <p class="dictation-permission-modal__description">
            Dictation requires access to your microphone. Please enable
            microphone permissions in your browser settings.
          </p>

          <div class="dictation-permission-modal__browser-instructions">
            <div class="dictation-permission-modal__instructions-title">
              How to enable in ${browserName}:
            </div>
            ${getBrowserInstructions(browser)}
          </div>
        </div>

        <div class="exec-approval-actions">
          <button class="btn" @click=${props.onClose}>Cancel</button>
          <button class="btn primary" @click=${props.onRetry}>Try Again</button>
        </div>
      </div>
    </div>
  `;
}
