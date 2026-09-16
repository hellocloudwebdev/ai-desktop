// PR40: packages/providers — Realtime Provider Tests
//
// Anthropic unsupported-verdict, Gemini capability mapping + negotiation,
// session event mapping, queue bounds, idempotent interrupt/close. Fake SDK
// sessions (structural) — no network, no microphone.

import { describe, expect, it } from "vitest";
import {
  AnthropicRealtimeProvider,
  GeminiLiveProvider,
  GeminiLiveSession,
  negotiateRealtimeCapabilities,
  unsupportedRealtimeCapabilities,
  REALTIME_EVENT_QUEUE_CAP,
  REALTIME_QUEUE_OVERFLOW_PREFIX,
  UnsupportedCapabilityError,
  GEMINI_MODELS,
} from "../../index.js";
import type { ModelDefinition } from "@ai-desktop/ai-core";

function geminiModel(id: string): ModelDefinition {
  const model = GEMINI_MODELS.find((m) => m.id === id);
  if (!model) {
    throw new Error(`unknown model ${id}`);
  }
  return model;
}

function anthropicModel(): ModelDefinition {
  return {
    id: "claude-3-5-sonnet-20241022" as never,
    providerId: "anthropic" as never,
    displayName: "Sonnet",
    description: "",
    contextWindow: 200000,
    maxOutputTokens: 4096,
    capabilities: ["text_generation", "streaming", "vision", "tool_use"],
  };
}

function fakeSdkSession() {
  const calls: string[] = [];
  return {
    calls,
    session: {
      sendRealtimeInput: (params: unknown) => {
        calls.push(`realtime:${JSON.stringify(params).length}`);
      },
      sendClientContent: (params: unknown) => {
        calls.push(`content:${JSON.stringify(params).length}`);
      },
      sendToolResponse: () => {
        calls.push("tool");
      },
      close: () => {
        calls.push("close");
      },
    },
  };
}

describe("Anthropic realtime (unsupported)", () => {
  it("reports no realtime support", () => {
    const provider = new AnthropicRealtimeProvider();
    expect(provider.supportsRealtime(anthropicModel())).toBe(false);
    expect(unsupportedRealtimeCapabilities().capabilities).toEqual([]);
    expect(provider.getCapabilities(anthropicModel()).capabilities).toEqual([]);
  });

  it("createSession throws typed error before any SDK use", async () => {
    const provider = new AnthropicRealtimeProvider();
    await expect(
      provider.createSession({ model: anthropicModel(), config: {} }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });
});

describe("Gemini capability mapping", () => {
  it("supports realtime on audio-capable models only", () => {
    const provider = new GeminiLiveProvider({ getClient: () => undefined as never });
    expect(provider.supportsRealtime(geminiModel("gemini:gemini-2.5-flash"))).toBe(true);
    expect(provider.supportsRealtime(geminiModel("gemini:gemini-2.5-flash-lite"))).toBe(false);
  });

  it("maps catalog capabilities to realtime strings", () => {
    const provider = new GeminiLiveProvider({ getClient: () => undefined as never });
    const caps = provider.getCapabilities(geminiModel("gemini:gemini-2.5-pro")).capabilities;
    expect(caps).toContain("audio-input");
    expect(caps).toContain("transcription");
    expect(caps).toContain("function-calling");
    expect(caps).toContain("vision");
  });

  it("negotiation fails clearly for missing capabilities", () => {
    const result = negotiateRealtimeCapabilities(
      ["audio-input", "session-resume"],
      ["audio-input"],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["session-resume"]);
    }
  });

  it("createSession rejects models without audio", async () => {
    const provider = new GeminiLiveProvider({ getClient: () => undefined as never });
    await expect(
      provider.createSession({ model: geminiModel("gemini:gemini-2.5-flash-lite"), config: {} }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });
});

describe("Gemini live session", () => {
  it("sends audio and text through the SDK session", async () => {
    const { session: fake, calls } = fakeSdkSession();
    const wrapper = GeminiLiveProvider.attachSession(
      new GeminiLiveSession(null as never),
      fake as never,
    );
    await wrapper.sendAudio({ payloadBase64: "AAAA" });
    await wrapper.sendInput("hello");
    expect(calls.some((c) => c.startsWith("realtime:"))).toBe(true);
    expect(calls.some((c) => c.startsWith("content:"))).toBe(true);
  });

  it("interrupt is idempotent", async () => {
    const { session: fake } = fakeSdkSession();
    const wrapper = GeminiLiveProvider.attachSession(
      new GeminiLiveSession(null as never),
      fake as never,
    );
    await wrapper.interrupt();
    await wrapper.interrupt();
    await wrapper.interrupt();
    const events: string[] = [];
    const iterator = wrapper.events()[Symbol.asyncIterator]();
    const first = await Promise.race([
      iterator.next(),
      new Promise<{ value: undefined }>((resolve) =>
        setTimeout(() => resolve({ value: undefined }), 100),
      ),
    ]);
    if (first.value) {
      events.push(first.value.kind);
    }
    expect(events).toContain("turn-complete");
    await wrapper.close();
  });

  it("close is idempotent and ends iteration", async () => {
    const { session: fake, calls } = fakeSdkSession();
    const wrapper = GeminiLiveProvider.attachSession(
      new GeminiLiveSession(null as never),
      fake as never,
    );
    await wrapper.close();
    await wrapper.close();
    expect(calls.filter((c) => c === "close")).toHaveLength(1);
    await expect(wrapper.sendAudio({ payloadBase64: "AAAA" })).rejects.toThrow();
  });

  it("bounds the event queue with overflow accounting", async () => {
    const wrapper = new GeminiLiveSession(null as never);
    for (let i = 0; i < REALTIME_EVENT_QUEUE_CAP + 10; i++) {
      wrapper.pushServerMessage({
        serverContent: { modelTurn: { parts: [{ text: `t${i}` }] } },
      });
    }
    await wrapper.close();
    let sawOverflow = false;
    let count = 0;
    for await (const event of wrapper.events()) {
      count += 1;
      if (event.error?.startsWith(REALTIME_QUEUE_OVERFLOW_PREFIX)) {
        sawOverflow = true;
      }
    }
    expect(count).toBeLessThanOrEqual(REALTIME_EVENT_QUEUE_CAP + 1);
    expect(sawOverflow).toBe(true);
  });

  it("maps server messages to neutral events", () => {
    expect(
      GeminiLiveProvider.mapServerMessage({
        serverContent: { inputTranscription: { text: "hel" } },
      }),
    ).toEqual([{ kind: "transcript-partial", text: "hel" }]);
    expect(
      GeminiLiveProvider.mapServerMessage({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm" } }] },
        },
      }),
    ).toEqual([{ kind: "audio-output", audioBase64: "AAAA", mimeType: "audio/pcm" }]);
    expect(GeminiLiveProvider.mapServerMessage({ setupComplete: {} })).toEqual([
      { kind: "turn-complete" },
    ]);
    expect(GeminiLiveProvider.mapServerMessage(null)).toEqual([]);
    expect(GeminiLiveProvider.mapServerMessage({ unknown: true })).toEqual([]);
  });
});
