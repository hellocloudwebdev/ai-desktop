import { describe, expect, it } from "vitest";
import { GEMINI_MODELS, GEMINI_MODEL_MAP, GEMINI_PROVIDER_ID } from "./gemini-models.js";

describe("packages/providers: Gemini Model Catalog (PR21.2)", () => {
  it("registers exactly three initial models", () => {
    expect(GEMINI_MODELS).toHaveLength(3);
    expect(GEMINI_MODEL_MAP.size).toBe(3);
  });

  it("every model belongs to ProviderId('gemini')", () => {
    expect(GEMINI_PROVIDER_ID).toBe("gemini");
    for (const model of GEMINI_MODELS) {
      expect(model.providerId).toBe(GEMINI_PROVIDER_ID);
    }
  });

  it("model IDs are globally unique and consistent", () => {
    const ids = GEMINI_MODELS.map((m) => m.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(GEMINI_MODELS.length);

    expect(ids).toContain("gemini:gemini-2.5-flash");
    expect(ids).toContain("gemini:gemini-2.5-flash-lite");
    expect(ids).toContain("gemini:gemini-2.5-pro");
  });

  it("provider-facing model names in metadata are exact Google model IDs", () => {
    const flash = GEMINI_MODEL_MAP.get("gemini:gemini-2.5-flash")!;
    const flashLite = GEMINI_MODEL_MAP.get("gemini:gemini-2.5-flash-lite")!;
    const pro = GEMINI_MODEL_MAP.get("gemini:gemini-2.5-pro")!;

    expect(flash.metadata?.nativeModelId).toBe("gemini-2.5-flash");
    expect(flashLite.metadata?.nativeModelId).toBe("gemini-2.5-flash-lite");
    expect(pro.metadata?.nativeModelId).toBe("gemini-2.5-pro");
  });

  it("all models support text generation and streaming", () => {
    for (const model of GEMINI_MODELS) {
      expect(model.capabilities).toContain("text_generation");
      expect(model.capabilities).toContain("streaming");
    }
  });

  it("Flash and Pro declare thinking, but Flash-Lite does NOT declare thinking", () => {
    const flash = GEMINI_MODEL_MAP.get("gemini:gemini-2.5-flash")!;
    const flashLite = GEMINI_MODEL_MAP.get("gemini:gemini-2.5-flash-lite")!;
    const pro = GEMINI_MODEL_MAP.get("gemini:gemini-2.5-pro")!;

    expect(flash.capabilities).toContain("thinking");
    expect(pro.capabilities).toContain("thinking");
    expect(flashLite.capabilities).not.toContain("thinking");
  });

  it("vision, tool use, and structured output capabilities match catalog decisions", () => {
    for (const model of GEMINI_MODELS) {
      expect(model.capabilities).toContain("vision");
      expect(model.capabilities).toContain("tool_use");
      expect(model.capabilities).toContain("structured_output");
    }
  });

  it("context window limits match current Gemini 2.5 documentation", () => {
    const flash = GEMINI_MODEL_MAP.get("gemini:gemini-2.5-flash")!;
    const flashLite = GEMINI_MODEL_MAP.get("gemini:gemini-2.5-flash-lite")!;
    const pro = GEMINI_MODEL_MAP.get("gemini:gemini-2.5-pro")!;

    expect(flash.contextWindow).toBe(1048576); // 1M tokens
    expect(flashLite.contextWindow).toBe(1048576); // 1M tokens
    expect(pro.contextWindow).toBe(2097152); // 2M tokens
  });
});
