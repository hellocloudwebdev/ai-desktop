// PR39: apps/desktop — Multimodal Chat E2E Tests
//
// End-to-end through the real ChatService (storage + EventBus + stream
// registry + model selection): attach -> validate -> vision model ->
// provider receives the image -> streamed UI events; unsupported models
// fail typed with zero provider calls; project isolation; cancellation.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMessageId, now, ok, type Result } from "@ai-desktop/shared";
import {
  createEventId,
  type AIEvent,
  type ChatRequest,
  type MessageCompletedEvent,
  type MessageDeltaEvent,
  type MessageStartedEvent,
  type ModelDefinition,
} from "@ai-desktop/ai-core";
import type { ProviderAdapter, ProviderConfigError } from "@ai-desktop/providers";
import { EventBus } from "@ai-desktop/agent-runtime";
import { ActiveStreamRegistry } from "../main/chat/active-stream-registry.js";
import { MediaArtifactStore } from "../main/chat/media-artifacts.js";
import { InMemoryEventRepository, createTestChatService } from "./test-helpers.js";

const PNG_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG_DATA, "base64"));

const VISION_CAPS: ModelDefinition["capabilities"] = [
  "text_generation",
  "streaming",
  "vision",
  "audio",
  "video",
];

class VisionAdapter implements ProviderAdapter {
  readonly providerId = "test-e2e-vision" as never;
  readonly calls: ChatRequest[] = [];
  private readonly _hang: boolean;
  constructor(hang = false) {
    this._hang = hang;
  }

  private _model(): ModelDefinition {
    return {
      id: "test:e2e-vision" as never,
      providerId: this.providerId,
      displayName: "E2E Vision",
      description: "",
      contextWindow: 100000,
      maxOutputTokens: 1024,
      capabilities: [...VISION_CAPS],
    };
  }

  async initialize(): Promise<void> {}
  async listModels(): Promise<readonly ModelDefinition[]> {
    return [this._model()];
  }
  async getModel(): Promise<ModelDefinition | undefined> {
    return this._model();
  }
  validateConfig(): Result<void, ProviderConfigError> {
    return ok(undefined);
  }
  supports(): boolean {
    return true;
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<AIEvent> {
    this.calls.push(request);
    if (this._hang) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("AbortError")), { once: true });
      });
    }
    const assistantMsgId = createMessageId();
    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: assistantMsgId,
      role: "assistant",
      content: [],
    } as MessageStartedEvent;
    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: assistantMsgId,
      deltaText: "I see a dot.",
    } as MessageDeltaEvent;
    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.completed",
      category: "core",
      messageId: assistantMsgId,
      finishReason: "end_turn",
    } as MessageCompletedEvent;
  }
}

function makeE2E(hang = false) {
  const provider = new VisionAdapter(hang);
  const streamRegistry = new ActiveStreamRegistry();
  const eventBus = new EventBus();
  const storage = new InMemoryEventRepository();
  const seen: AIEvent[] = [];
  void eventBus.subscribe(async (event) => {
    seen.push(event);
  });
  const service = createTestChatService({
    provider,
    streamRegistry,
    eventBus,
    storage,
    models: [
      {
        id: "test:e2e-vision" as never,
        providerId: "test-e2e-vision" as never,
        displayName: "E2E Vision",
        description: "",
        contextWindow: 100000,
        maxOutputTokens: 1024,
        capabilities: [...VISION_CAPS],
      },
    ],
  });
  return { service, provider, storage, seen, eventBus };
}

describe("chat multimodal e2e (PR39)", () => {
  it("attach -> validate -> vision model -> provider receives image -> UI events stream", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-e2e-"));
    try {
      const artifacts = new MediaArtifactStore({ rootDir: root });
      const saved = await artifacts.save({
        projectId: "projectA",
        filename: "dot.png",
        mimeType: "image/png",
        bytes: PNG_BYTES,
      });
      const loaded = await artifacts.load("projectA", saved.artifactId);

      const { service, provider, seen } = makeE2E();
      const result = await service.sendMessage({
        content: "What is in this image?",
        parts: [
          {
            type: "image",
            mimeType: loaded.mimeType,
            data: Buffer.from(loaded.bytes).toString("base64"),
          },
        ],
        modelId: "test:e2e-vision",
      });
      await result.completion;

      expect(provider.calls).toHaveLength(1);
      const userMsg = provider.calls[0]?.messages.find((m) => m.role === "user");
      const imagePart = userMsg?.content.find((p) => p.type === "image");
      expect(imagePart).toBeDefined();
      expect((imagePart as { mimeType?: string }).mimeType).toBe("image/png");

      const types = seen.map((e) => e.type);
      expect(types).toContain("message.created");
      expect(types).toContain("message.completed");
      const deltas = seen.filter((e) => e.type === "message.delta");
      expect(deltas.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("unsupported model fails typed with zero provider calls (e2e)", async () => {
    const provider = new VisionAdapter();
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const storage = new InMemoryEventRepository();
    const service = createTestChatService({
      provider,
      streamRegistry,
      eventBus,
      storage,
      models: [
        {
          id: "test:e2e-text" as never,
          providerId: "test-e2e-vision" as never,
          displayName: "E2E Text",
          description: "",
          contextWindow: 100000,
          maxOutputTokens: 1024,
          capabilities: ["text_generation", "streaming"],
        },
      ],
    });
    await expect(
      service.sendMessage({
        content: "Describe this.",
        parts: [{ type: "image", mimeType: "image/png", data: PNG_DATA }],
        modelId: "test:e2e-text",
      }),
    ).rejects.toThrow(/vision/);
    expect(provider.calls).toHaveLength(0);
  });

  it("project isolation: artifact from A is unusable in B", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-e2e-"));
    try {
      const artifacts = new MediaArtifactStore({ rootDir: root });
      const saved = await artifacts.save({
        projectId: "projectA",
        filename: "a.png",
        mimeType: "image/png",
        bytes: PNG_BYTES,
      });
      // Direct store scoping asserts: project B cannot resolve A's artifact.
      await expect(artifacts.load("projectB", saved.artifactId)).rejects.toThrow();
      await expect(artifacts.getMetadata("projectB", saved.artifactId)).rejects.toThrow();
      // And project A still can (no collateral denial).
      const loaded = await artifacts.load("projectA", saved.artifactId);
      expect(loaded.mimeType).toBe("image/png");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancellation mid-stream emits message.cancelled and double-cancel is idempotent", async () => {
    const { service, seen } = makeE2E(true);
    const result = await service.sendMessage({
      content: "Describe this slowly.",
      parts: [{ type: "image", mimeType: "image/png", data: PNG_DATA }],
      modelId: "test:e2e-vision",
    });
    const first = service.cancel(result.assistantMessageId);
    const second = service.cancel(result.assistantMessageId);
    await result.completion;
    expect(first).toBe(true);
    expect(second).toBe(true);
    const types = seen.map((e) => e.type);
    expect(types).toContain("message.cancelled");
    expect(types.filter((t) => t === "message.cancelled")).toHaveLength(1);
  });
});
