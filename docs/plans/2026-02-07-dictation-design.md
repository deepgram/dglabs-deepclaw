# Voice Dictation in Web Chat

**Date:** 2026-02-07
**Status:** Design complete, ready for implementation

## Overview

Add voice dictation to the web chat compose box using Deepgram's Flux model for real-time speech-to-text with intelligent end-of-thought detection.

## User Flow

1. User clicks mic button (or presses `Cmd/Ctrl+Shift+D`)
2. Browser requests mic permission if not already granted
3. Mic button turns red/pulsing to indicate active recording
4. Audio streams to gateway, which proxies to Deepgram Flux
5. Live transcript appears in textarea as user speaks (interim results updating in real-time)
6. Flux detects end-of-thought → recording auto-stops (or user manually stops)
7. Final transcript remains in textarea; user can edit and press Enter to send

## Technical Architecture

### Browser Side

**New module:** `ui/src/ui/dictation.ts`

- Mic access via `navigator.mediaDevices.getUserMedia({ audio: true })`
- Audio capture using `AudioWorklet` (required; no ScriptProcessorNode fallback)
- Output format: linear16 PCM, 16kHz sample rate
- WebSocket connection to gateway dictation endpoint
- Receives transcript events, updates textarea draft state

### Gateway Side

**New WebSocket endpoint:** `/dictation/stream`

- Authenticates using existing gateway auth mechanism
- Opens upstream WebSocket to Deepgram:
  ```
  wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&interim_results=true&punctuate=true&smart_format=true
  ```
- Proxies audio chunks: browser → Deepgram
- Proxies transcript events: Deepgram → browser
- Uses existing `DEEPGRAM_API_KEY` from provider config

### Message Flow

```
Browser mic
    ↓
AudioWorklet (PCM chunks, ~80ms)
    ↓
Gateway WebSocket (/dictation/stream)
    ↓
Deepgram WebSocket (/v2/listen, Flux)
    ↓
Transcript events (Results, UtteranceEnd)
    ↓
Gateway → Browser
    ↓
Textarea updates
```

### Deepgram Flux Configuration

| Parameter         | Value             | Purpose                                         |
| ----------------- | ----------------- | ----------------------------------------------- |
| `model`           | `flux-general-en` | Conversational model with end-of-turn detection |
| `encoding`        | `linear16`        | PCM audio format                                |
| `sample_rate`     | `16000`           | 16kHz sample rate                               |
| `interim_results` | `true`            | Stream partial transcripts                      |
| `punctuate`       | `true`            | Auto-punctuation                                |
| `smart_format`    | `true`            | Formatting for numbers, dates, etc.             |

Flux provides ~260ms end-of-turn detection latency.

## UI Components

### Mic Button

**Location:** `chat-compose__actions` div, before "New session" button

**States:**

- `idle` - Gray mic icon, clickable
- `recording` - Red pulsing mic icon, clickable to stop
- `disabled` - Grayed out (no Deepgram API key configured)

**Tooltip:**

- When enabled: "Dictate (⌘⇧D)" / "Dictate (Ctrl+Shift+D)"
- When disabled: "Configure Deepgram API key to enable dictation"

### Recording Indicator

- Mic icon pulses with CSS animation (`@keyframes pulse`)
- Visual state clearly indicates active recording

### Textarea Behavior

- Interim text may appear in lighter color or italic (distinguishes unconfirmed words)
- Final text renders in normal style as Deepgram confirms
- Existing draft text preserved; dictation appends at cursor position
- User can type while recording (both inputs work simultaneously)

### Permission Modal

Triggered when `getUserMedia()` fails with `NotAllowedError`.

**Content:**

- Header: "Microphone Access Required"
- Browser-specific instructions for Chrome, Safari, Firefox, Edge
- Buttons: "Try Again", "Cancel"

## Keyboard Shortcut

- **Shortcut:** `Cmd+Shift+D` (macOS) / `Ctrl+Shift+D` (Windows/Linux)
- **Behavior:** Toggles dictation on/off
- **Discoverability:** Shown in mic button tooltip

## Feature Detection

### Gateway Hello Response

Add to gateway hello payload:

```typescript
features: {
  dictation: boolean; // true if DEEPGRAM_API_KEY is configured
}
```

### Browser Requirements

- `navigator.mediaDevices.getUserMedia` support
- `AudioWorklet` support (Chrome 66+, Firefox 76+, Safari 14.1+)

If AudioWorklet unavailable, mic button is hidden (no fallback for v1).

## Error Handling

### Connection Failures

| Scenario                | Behavior                                                    |
| ----------------------- | ----------------------------------------------------------- |
| Gateway WebSocket fails | Inline error: "Dictation unavailable. Check connection."    |
| Deepgram upstream fails | Error event to browser: "Transcription service unavailable" |
| Transient failure       | Auto-retry once, then show error                            |

### During Recording

| Scenario                 | Behavior                                                 |
| ------------------------ | -------------------------------------------------------- |
| WebSocket disconnects    | Stop recording, keep transcript, show brief error        |
| User navigates away      | Stop recording gracefully (send CloseStream)             |
| No audio for 10+ seconds | Subtle hint: "No audio detected. Check your microphone." |

### Concurrent Usage

- Only one dictation session at a time
- Click mic while recording = stop
- Typing while recording = both work (no conflict)

## Configuration

### Required

- `DEEPGRAM_API_KEY` environment variable (existing)

### No New Config

- Dictation enabled automatically if Deepgram key is present
- No separate toggle to enable/disable dictation feature
- Uses system default microphone (no mic picker)

## Scope

**In scope (v1):**

- Web UI chat only
- Single language (English via `flux-general-en`)
- System default microphone

**Out of scope (future):**

- Native apps (iOS, macOS, Android)
- TUI
- Language selection
- Microphone picker
- Waveform visualization

## Files to Create/Modify

### New Files

- `ui/src/ui/dictation.ts` - Dictation state machine, mic handling, WebSocket client
- `ui/src/ui/audio-worklet.ts` - AudioWorklet processor for PCM capture
- `ui/src/ui/components/mic-permission-modal.ts` - Permission help modal
- `ui/src/styles/dictation.css` - Mic button states, pulse animation
- `src/gateway/server-dictation.ts` - Gateway WebSocket proxy to Deepgram

### Modified Files

- `ui/src/ui/views/chat.ts` - Add mic button to compose area
- `ui/src/ui/app-chat.ts` - Integrate dictation state
- `src/gateway/server.ts` - Register dictation WebSocket endpoint
- `src/gateway/protocol/schema/hello.ts` - Add `features.dictation` field

## Testing

- Unit tests for dictation state machine
- Integration test for gateway proxy (mock Deepgram)
- Manual browser testing for mic permission flows
- E2E test with real Deepgram (live test, requires key)
