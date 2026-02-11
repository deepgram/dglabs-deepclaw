# Control UI

Lit-based single-page application for managing the OpenClaw gateway. ~130 TypeScript files using web components (not React).

## Architecture

Single root `OpenClawApp` LitElement (`app.ts`) with behavior split across partial files:

```
app.ts              → Main component class, all @state() properties (~130 reactive properties)
app-render.helpers.ts → Tab rendering, chat controls, session selector
app-chat.ts         → Chat message handling, send/receive, refresh
app-gateway.ts      → Gateway event handlers (wired to GatewayBrowserClient)
app-events.ts       → DOM event handlers (keyboard, resize, etc.)
app-channels.ts     → Channel-specific event handlers
app-scroll.ts       → Auto-scroll behavior for chat
app-tool-stream.ts  → Tool execution output streaming
app-settings.ts     → Settings persistence and URL sync
```

**No shadow DOM** — `createRenderRoot()` returns `this`, allowing global CSS.

## State Management

- `@state()` decorators on `OpenClawApp` trigger Lit re-renders on mutation
- No external state store (no Redux, no context) — state lives directly on the component
- Controllers in `controllers/` are **pure functions** that take a state object and mutate it or call the gateway
- Pattern: event handler → calls controller function → controller mutates state → Lit auto-re-renders

Example controller interface:

```typescript
// controllers/agents.ts
export type AgentsState = { client: GatewayBrowserClient; agents: AgentInfo[]; ... };
export async function loadAgents(state: AgentsState): Promise<void> {
  const res = await state.client.request<AgentsResponse>("agents.list");
  state.agents = res.agents;  // Mutation triggers re-render
}
```

## Gateway Communication

`GatewayBrowserClient` (`gateway.ts`) — WebSocket RPC client:

- `client.request<T>(method, params)` for RPC calls (e.g., `config.get`, `voicecall.activeCalls`)
- Event frames streamed via `onEvent` callback
- Device authentication via Ed25519 signing + token refresh
- Auto-reconnect with exponential backoff

## Tabs & Navigation

12 tabs in 4 groups defined in `navigation.ts`:

| Group    | Tabs                                                             |
| -------- | ---------------------------------------------------------------- |
| Chat     | `chat`                                                           |
| Control  | `overview`, `channels`, `instances`, `sessions`, `usage`, `cron` |
| Agent    | `agents`, `skills`, `nodes`                                      |
| Settings | `config`, `debug`, `logs`                                        |

- `Tab` type union in `navigation.ts`
- URL-based routing via `pathForTab()` / `tabFromPath()`
- Mobile shows only: `chat`, `overview`, `channels`, `agents`

## Polling

`app-polling.ts` (via `app-events.ts` lifecycle) sets up intervals:

- Logs: every 2s
- Debug: every 3s
- Nodes: every 5s
- Tab-specific polling starts/stops on tab change

## Adding a New Tab/View

1. Add tab name to `Tab` type and `TAB_GROUPS` in `navigation.ts`
2. Add `@state()` properties to `app.ts` for the tab's data
3. Create render function in `views/your-tab.ts`
4. Add render case in `app-render.helpers.ts` or wherever tab rendering is dispatched
5. Create controller in `controllers/your-tab.ts` with state type + load/save functions
6. Add polling in `app-polling.ts` if data needs periodic refresh
7. Wire event handlers in `app-events.ts` if needed

## Key Files

| File                           | Purpose                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| `src/ui/app.ts`                | Root component, all `@state()` properties                       |
| `src/ui/app-render.helpers.ts` | Tab rendering, navigation, chat controls                        |
| `src/ui/app-chat.ts`           | Chat send/receive/refresh logic                                 |
| `src/ui/app-gateway.ts`        | Gateway WebSocket event handlers                                |
| `src/ui/app-events.ts`         | DOM event handlers                                              |
| `src/ui/gateway.ts`            | `GatewayBrowserClient` — WebSocket RPC                          |
| `src/ui/navigation.ts`         | Tab type, groups, URL routing                                   |
| `src/ui/storage.ts`            | `localStorage` persistence (`openclaw.control.settings.v1` key) |
| `src/ui/types/chat-types.ts`   | Chat message types                                              |
| `src/ui/controllers/*.ts`      | Pure controller functions (~20 files)                           |
| `src/ui/views/*.ts`            | Pure render functions (~15 files)                               |
| `src/ui/chat/*.ts`             | Chat helpers: message normalizer, tool cards, copy-as-markdown  |
| `src/ui/dictation.ts`          | Voice input via DictationClient                                 |
| `src/ui/theme.ts`              | Light/dark/system theme management                              |

## Styling

- Global CSS via `src/styles.css` (no shadow DOM scoping)
- Feature CSS in `styles/chat/`, `styles/components/`, etc.
- CSS custom properties for theming (light/dark modes)
- Responsive design with `layout.mobile.css`
- BEM-like naming: `.nav-item__icon`, `.chat-message__content`

## Build & Test

```bash
pnpm ui:build    # Vite production build → ../dist/control-ui/
pnpm ui:dev      # Vite dev server with HMR
```

Testing: Vitest with `@vitest/browser-playwright` (Chromium headless)

```bash
cd ui && pnpm test    # Runs browser tests
```

Test files are co-located: `chat.test.ts` next to `chat.ts` (~23 test files).

## Gotchas

- **`pnpm build` wipes `dist/`** including UI assets — always run `pnpm ui:build` after `pnpm build`
- **UI assets must be baked into Docker image** — `pnpm ui:build` before `docker build`, or gateway shows "Control UI assets missing"
- **`localStorage` key**: `openclaw.control.settings.v1` — stores gateway URL, token, session key, theme, focus mode, thinking display, split ratio, nav collapse state
- **No shadow DOM** — All CSS is global. Be careful with selector specificity.
- **Views are pure** — They take typed props and return `html` templates. Side effects belong in controllers or app-level event handlers.
- **State type casting** — Controllers define narrow state interfaces (e.g., `ChatState`, `AgentsState`) that are subsets of the full app state. The app passes itself (or a subset) as the state parameter.
