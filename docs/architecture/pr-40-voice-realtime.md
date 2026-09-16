# PR40 — Voice & Realtime Foundation

## 1. Objective

PR40 adds voice as an interaction mode over the existing runtime — not a
second agent runtime. Realtime sessions flow through the established
Chat/Agent Runtime, ToolRegistry, PermissionManager, and universal
ToolExecutor, reusing PR39's multimodal data plane for persistent media
while keeping ephemeral audio streams bounded and in memory.

```text
Workspace (Voice surface)
   ↓
typed preload
   ↓
typed IPC (realtime:* — no execute channel)
   ↓
RealtimeService (lifecycle + queues + interruption + cleanup)
   ↓
RealtimeProvider (Gemini Live verified; Anthropic unsupported)
   ↓
existing Chat / Agent Runtime → ToolRegistry → PermissionManager → ToolExecutor
```

---

## 2. Canonical Contracts (`@ai-desktop/ai-core`)

New module `realtime.ts` (pure; SDK-free):

- Branded `RealtimeSessionId`/`RealtimeTurnId`/`RealtimeStreamId`.
- `AudioFormat` (pcm16/g711-ulaw/g711-alaw/opus; 8/16/24/48 kHz;
  1–2 channels; 10–100 ms frames) with
  `DEFAULT_REALTIME_AUDIO_FORMAT` (pcm16/16 kHz/mono/20 ms).
- `AudioChunk` (sequence, timestamp, ≤64 KB base64) with
  `validateAudioChunk` (oversized/malformed).
- Bounds: 64 KB chunks, 256-deep queues, 4 sessions/project,
  30-minute max duration, 8 K transcript chars, 30 s chunk timeout.
- State machine: `idle → requesting-permission → starting → active →
listening ⇄ thinking ⇄ speaking → interrupted → listening → stopping
→ stopped`, plus `failed`/`cancelled` terminals with
  `VALID_REALTIME_TRANSITIONS` enforcement (typed errors, never silent).
- Config: project/model IDs, format, turn detection
  (`provider|client|manual`, default provider), capability subset,
  duration cap, optional conversation for chat handoff.
- Capabilities (kebab-case strings): audio/text in/out, streaming,
  interruption, server/client VAD, transcription, function-calling,
  vision, video, turn-detection, session-resume; `negotiateRealtimeCapabilities`
  (missing list, no silent degrade).
- Transcripts: partial (ephemeral UI hint) vs final (durable);
  `transcriptSupersedes` (same turn + final flag).
- Events: standalone Zod schemas in `category: "extension"` (AIEvent
  union untouched) — session._/turn._/transcript.*/audio._Moments.
  Durable: session._ + transcript.final + turn.completed only; audio
  chunks and partials never persist.
- Errors: 8-code taxonomy (permission/capability/transport/audio/
  provider/state/timeout/cancelled), secret-free messages.
- `realtimeRiskFor`: create/start medium, interrupt/stop low,
  capture-start high (microphone).
- `UNTRUSTED REALTIME TRANSCRIPT` framing for provider/user-derived text.

---

## 3. Providers (SDKs isolated, verified)

- Abstraction (`realtime-provider.ts`): `RealtimeProvider`
  (supportsRealtime/getCapabilities/createSession) +
  `RealtimeProviderSession` (sendAudio/sendInput/interrupt/close/
  events) + neutral `RealtimeProviderEvent` kinds. Negotiation runs
  before creation; unsupported fails clearly.
- Anthropic (`anthropic-realtime.ts`): realtime unsupported —
  verified zero realtime/WebSocket hits in SDK 0.124.0 `.d.ts`.
  `supportsRealtime` always false; `createSession` throws typed
  `UnsupportedCapabilityError`. No faking.
- Gemini (`gemini-live.ts`): verified Live API wiring —
  `client.live.connect({model, callbacks, config})`,
  `responseModalities: [Modality.AUDIO]`, `sendRealtimeInput({audio:
{data, mimeType}})` / `sendClientContent` / `close()`. Server
  messages map structurally (input/output transcription, inline audio,
  turn-complete; never throws). Bounded 256-deep queue (drop-oldest +
  overflow accounting). `interrupt()` is locally observed (SDK exposes
  no turn-cancel primitive — documented); `close()` idempotent.
  Client factory reads operator-configured `GEMINI_API_KEY` at session
  start (`createGeminiLiveProviderFromEnv`); missing key → typed error.
- Catalog unchanged (audio/video already on flash/pro from PR39).

---

## 4. Desktop Service (`main/realtime/`)

- `RealtimeService`: create (permission + one-active-per-project +
  project budget) → requesting-permission → capture-start gate →
  session-start gate → starting → provider session → capture start →
  active → listening, with a per-session pump mapping provider events.
  Every transition validated; invalid → typed error.
- Audio: `ingestAudio` re-checks capture permission per chunk
  (revocation stops flow at the next frame), validates bounds, caps
  queues, forwards to provider, opens turns. Capture (`AudioCapture`)
  and playback (`AudioPlayback`) are interfaces; main ships
  `NullAudioCapture` (CI-safe) + `BufferedPlayback` (bounded).
- Interruption: speaking → playback stop + provider interrupt →
  interrupted → listening with a fresh turn; idempotent no-op outside
  speaking; repeated calls safe.
- Cancellation: `cancelSession` idempotent (unknown/finished → cancelled
  snapshot); all paths converge on `_cleanup` (abort controller, capture
  stop+release, playback stop, provider close, queue drain, terminal
  state, durable event) — each step individually guarded.
- Chat handoff: final transcripts → `ChatService.sendMessage` when the
  session carries a conversationId (normal persistence/projection;
  partials never become messages, never Memory/Documents).
- Tool bridge: `dispatchToolCall` routes provider function calls through
  the injected invoker (universal lifecycle + permission); failures
  return text, never throw to providers.
- Transcripts retained in a bounded in-memory buffer (10 partials,
  50 finals) for UI polling; cleared on cleanup; never SQLite.
- Singletons: `getRealtimeService()` (Anthropic + env-keyed Gemini
  providers, chat handoff wired).

---

## 5. IPC, Workspace, Security

- Channels: `realtime:capabilities/session:create/start/interrupt/stop/
get/list/transcript/audio` (typed schemas; 87 380-char audio cap ≈
  64 KB decoded). No `realtime:execute`/`voice:execute`/`audio:execute`.
  Microphone handles and provider sessions never cross IPC.
- Preload: 9 thin typed commands. Renderer: `voice` surface (sidebar
  tab + union entry) with mic indicator, state badge, start/interrupt/
  stop controls, live + final transcripts, error display. Capture via
  browser MediaRecorder (user-gated, released on stop); 1 s polling for
  state/transcripts over typed invoke (no push privileges).
- Permissions: capability `realtime` (create/start medium, interrupt/
  stop low, capture-start high); denial fail-closed; revocation stops
  audio at the next chunk; stop never blocked by denial.
- Privacy: mic → memory → provider → discard. No raw audio in SQLite,
  EventBus persistence, logs, Memory, or Documents.
- Isolation: sessions/transcripts/subscriptions project-scoped;
  snapshots carry no secret fields; cross-project access rejected.
- Injection: transcripts framed as untrusted data; voice approval never
  authorizes tools (PermissionManager authoritative); tool descriptions
  stay metadata.

---

## 6. Verification

- ai-core: 54 realtime contract tests (IDs, formats, chunks, full
  transition matrix, negotiation, transcripts, events, errors, risk,
  framing).
- Providers: 11 realtime tests (unsupported verdict, capability maps,
  negotiation, send paths, idempotent interrupt/close, queue bounds,
  message mapping) over fake SDK sessions.
- Desktop: 16 service tests (lifecycle, guards, concurrency, failure,
  interruption, audio, transcripts, persistence split, cancellation,
  isolation, tool bridge, primitives) + 29 security (+1 conditional
  skip) + 6 E2E (lifecycle, interruption, isolation, failure cleanup,
  cancellation idempotence, denied start).
- IPC (7) + renderer surface (5) tests. Gates: `architecture:check`,
  `typecheck`, `lint`, `test`, `build`, `format:check` — zero new
  dependencies (Live API already in `@google/genai` 2.21.0).
