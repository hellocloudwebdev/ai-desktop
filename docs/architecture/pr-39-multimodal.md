# PR39 — Multimodal Foundation

## 1. Objective

PR39 establishes the canonical multimodal **data plane** for text, images,
audio, and video: provider-neutral contracts, validated attachments,
project-scoped artifact references, capability negotiation, provider
translation, multimodal chat, and safe rendering. PR40 owns voice and
realtime; PR39 builds no realtime infrastructure.

```text
User / Tool / Provider
        ↓
Canonical multimodal content (ai-core)
        ↓
Capability negotiation (fail before execution)
        ↓
Provider adapter (SDK types isolated)
        ↓
Model
        ↓
Canonical streamed response (existing events)
        ↓
Chat / Agent / Workspace / RichSurface
```

---

## 2. Canonical Model (`@ai-desktop/ai-core`)

- `content.ts` (pre-existing, extended by validation): `TextContent`,
  `ImageContent`, `AudioContent`, `VideoContent`, `FileContent` +
  `ContentPart` discriminated union, constructors, and `getMessageText`.
- `multimodal.ts` (new): branded `MediaArtifactId`/`AttachmentId`;
  `MediaSource` union (artifact reference | bounded base64 data |
  remote URL — renderer never fetches); MIME allowlists (4 image, 6
  audio, 3 video formats); `ValidatedImage/Audio/VideoPart` with
  dimension/duration bounds; `validateMediaPart` (typed
  unsupported/invalid/too-large); 10 centralized bounds (10 MB images,
  25 MB audio/attachments, 100 MB video, 16 parts/message, 110 MB
  media/message, 14 MB data URLs with 1.4× expansion accounting);
  attachment lifecycle (`pending → validated → available`, `failed`,
  `deleted`) with validated transitions; `MediaArtifact` metadata-only
  schema; `negotiateCapabilities` (first-unsupported-wins) +
  `createCapabilityError` (provider/model/modality/supported, never
  secrets); 11-code media error taxonomy; `UNTRUSTED MEDIA CONTENT`
  framing; audit-only `multimodal.request.*` events (message
  deltas/completion reused, no second streaming system); `mediaRiskFor`
  (create/read low, delete/fetch medium).

---

## 3. Providers (SDKs isolated, versions pinned)

- Anthropic (`@anthropic-ai/sdk` 0.124.0): text/image translation
  unchanged; audio/video/file throw typed `UnsupportedCapabilityError`
  (verified: SDK `ContentBlockParam` has no audio input blocks).
- Gemini (`@google/genai` 2.21.0): image unchanged; audio/video via
  `inlineData` (bounded) with capability gating; pre-existing URI →
  `fileData` path kept. Byte caps enforced before building native parts.
- Catalogs: `audio` + `video` added to `gemini-2.5-flash`/`pro` only
  (SDK `Part` generality + 2.5-tier support; Flash-Lite conservatively
  unchanged). No speculative capabilities.

---

## 4. Chat, Agent, Artifacts, Persistence

- `ChatService.sendMessage` accepts optional multimodal `parts`
  alongside text; `validateRequestCapabilities` extended (audio/video
  capabilities, 16-part / 110 MB message bounds) — violations throw
  before any provider call (zero-call tests). Streaming, cancellation
  (idempotent via `ActiveStreamRegistry`), memory, and tools untouched.
- Agent Runtime unchanged: `TaskNodeSpec.metadata` already carries
  payloads; `DesktopModelInvoker` passes multimodal node messages
  through with no text coercion. No new agent loop.
- `MediaArtifactStore` (main-side): bytes under
  `<root>/<projectId>/<artifactId>.bin` + JSON sidecar; path-policy
  containment; MIME allowlist + PNG/JPEG/GIF/WebP magic validation +
  PNG IHDR dimension parse (>67 MP rejected as decompression bombs);
  project-scoped load/metadata/delete (idempotent); abort-aware save.
  References (not bytes) flow through events/IPC.
- Persistence: Prisma `AttachmentRecord` → `attachments` table +
  migration + `AttachmentRepository` interface/impl (metadata only).
  Attachments ≠ Documents ≠ Memory (no automatic ingestion anywhere).

---

## 5. IPC, Workspace, Security

- `attachments:list/get/upload/delete/preview` (typed, projectId
  everywhere, 36 MB upload cap, 200 KB preview cap images-only).
  No `read-path`/`execute` channels.
- Preload: five thin typed wrappers. Renderer: Files-surface
  attachments section (upload via FileReader, list, delete, bounded
  preview), chat thumbnails for small image parts + metadata cards
  otherwise. No `fs`/`path`/Prisma/SDK in renderer (source-asserted).
- Remote URLs: accepted as _references_ only; resolution is not
  implemented (unresolved references never submitted) — SSRF surface
  unchanged, PR40-or-later concern.
- Security: traversal/absolute/symlink rejection, MIME spoof and bomb
  rejection, cross-project isolation (A/B artifact tests), secret-free
  errors/metadata, injection framing for media-derived text, EXIF
  minimization by non-exposure (metadata never forwarded to models).
- E2E: attach → vision model → streamed UI events; unsupported model
  → typed error with zero provider calls; project isolation;
  idempotent cancellation.

---

## 6. Non-goals (PR40 owns voice/realtime)

No realtime voice, WebRTC, microphone streaming, live audio agents,
second streaming system, OCR/transcription engines, arbitrary fetching
or execution, automatic document/memory ingestion, or SDK types in
ai-core. Gates: `architecture:check`, `typecheck`, `lint`, `test`,
`build`, `format:check` — zero new dependencies.
