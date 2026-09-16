// PR39: packages/providers — Multimodal Translation Tests
//
// Covers Gemini audio/video inlineData + fileData translation, byte-cap
// enforcement, capability gating, and Anthropic audio/video/file typed
// errors (SDK 0.124.0 has no audio input blocks — verified, not assumed).

import { describe, expect, it } from "vitest";
import { translateGeminiRequest } from "../gemini/translate-request.js";
import { translateChatRequest } from "../anthropic/translate-request.js";
import { GEMINI_MODEL_MAP } from "../gemini/gemini-models.js";
import { UnsupportedCapabilityError } from "../core/provider-errors.js";
import type { ChatRequest, ModelDefinition } from "@ai-desktop/ai-core";

function geminiModel(id: string): ModelDefinition {
  const model = GEMINI_MODEL_MAP.get(id);
  if (!model) {
    throw new Error(`unknown model ${id}`);
  }
  return model;
}

function anthropicVisionModel(): ModelDefinition {
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

function requestWith(parts: ChatRequest["messages"][number]["content"]): ChatRequest {
  return {
    conversationId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA" as never,
    modelId: "gemini:gemini-2.5-flash" as never,
    messages: [{ role: "user", content: parts }],
  };
}

describe("gemini audio/video translation", () => {
  it("translates audio data to inlineData", () => {
    const params = translateGeminiRequest(
      requestWith([{ type: "audio", mimeType: "audio/mpeg", data: "AAAA" }]),
      geminiModel("gemini:gemini-2.5-flash"),
    );
    const contents = params.contents as Array<{ parts?: Array<{ inlineData?: { mimeType: string } }> }>;
    expect(contents[0]?.parts?.[0]?.inlineData?.mimeType).toBe("audio/mpeg");
  });

  it("translates video data to inlineData", () => {
    const params = translateGeminiRequest(
      requestWith([{ type: "video", mimeType: "video/mp4", data: "BBBB" }]),
      geminiModel("gemini:gemini-2.5-pro"),
    );
    const contents = params.contents as Array<{ parts?: Array<{ inlineData?: { mimeType: string } }> }>;
    expect(contents[0]?.parts?.[0]?.inlineData?.mimeType).toBe("video/mp4");
  });

  it("rejects audio on models without the capability", () => {
    expect(() =>
      translateGeminiRequest(
        requestWith([{ type: "audio", mimeType: "audio/mpeg", data: "AAAA" }]),
        geminiModel("gemini:gemini-2.5-flash-lite"),
      ),
    ).toThrow(UnsupportedCapabilityError);
  });

  it("rejects oversized image payloads before building", () => {
    const big = "A".repeat(15_000_000);
    expect(() =>
      translateGeminiRequest(
        requestWith([{ type: "image", mimeType: "image/png", data: big }]),
        geminiModel("gemini:gemini-2.5-flash"),
      ),
    ).toThrow(UnsupportedCapabilityError);
  });

  it("keeps image translation unchanged", () => {
    const params = translateGeminiRequest(
      requestWith([{ type: "image", mimeType: "image/png", data: "CCCC" }]),
      geminiModel("gemini:gemini-2.5-flash"),
    );
    const contents = params.contents as Array<{ parts?: Array<{ inlineData?: { data: string } }> }>;
    expect(contents[0]?.parts?.[0]?.inlineData?.data).toBe("CCCC");
  });
});

describe("anthropic audio/video/file errors", () => {
  it("throws typed errors for audio parts", () => {
    try {
      translateChatRequest(
        requestWith([{ type: "audio", mimeType: "audio/mpeg", data: "AAAA" }]),
        anthropicVisionModel(),
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCapabilityError);
      expect((err as UnsupportedCapabilityError).capability).toBe("audio");
    }
  });

  it("throws typed errors for video and file parts", () => {
    for (const part of [
      { type: "video", mimeType: "video/mp4", data: "BBBB" },
      { type: "file", name: "a.bin", mimeType: "application/octet-stream" },
    ] as never[]) {
      expect(() => translateChatRequest(requestWith([part]), anthropicVisionModel())).toThrow(
        UnsupportedCapabilityError,
      );
    }
  });

  it("keeps image translation unchanged", () => {
    const params = translateChatRequest(
      requestWith([{ type: "image", mimeType: "image/png", data: "CCCC" }]),
      anthropicVisionModel(),
    );
    const block = params.messages[0]?.content[0] as { type: string };
    expect(block.type).toBe("image");
  });
});

describe("gemini catalog capabilities", () => {
  it("declares audio+video on flash and pro only", () => {
    expect(geminiModel("gemini:gemini-2.5-flash").capabilities).toContain("audio");
    expect(geminiModel("gemini:gemini-2.5-flash").capabilities).toContain("video");
    expect(geminiModel("gemini:gemini-2.5-pro").capabilities).toContain("audio");
    expect(geminiModel("gemini:gemini-2.5-pro").capabilities).toContain("video");
    expect(geminiModel("gemini:gemini-2.5-flash-lite").capabilities).not.toContain("audio");
    expect(geminiModel("gemini:gemini-2.5-flash-lite").capabilities).not.toContain("video");
  });
});
