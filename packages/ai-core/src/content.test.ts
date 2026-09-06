import { describe, expect, it } from "vitest";
import {
  audioPart,
  ContentPartSchema,
  filePart,
  imagePart,
  isImagePart,
  isTextPart,
  isToolCallPart,
  isToolResultPart,
  textPart,
  toolCallPart,
  toolResultPart,
  videoPart,
} from "./content.js";
import { createToolCallId } from "@ai-desktop/shared";

describe("ai-core content: Multimodal Content Parts", () => {
  it("creates and validates text content parts", () => {
    const part = textPart("Hello world");
    expect(isTextPart(part)).toBe(true);
    expect(isImagePart(part)).toBe(false);
    expect(ContentPartSchema.safeParse(part).success).toBe(true);
  });

  it("creates and validates image content parts", () => {
    const part = imagePart("image/png", "base64data...", {
      width: 800,
      height: 600,
      alt: "Diagram",
    });
    expect(isImagePart(part)).toBe(true);
    expect(part.mimeType).toBe("image/png");
    expect(ContentPartSchema.safeParse(part).success).toBe(true);
  });

  it("creates and validates audio and video content parts", () => {
    const audio = audioPart("audio/mp3", "audiodata...", "mp3");
    expect(audio.type).toBe("audio");
    expect(ContentPartSchema.safeParse(audio).success).toBe(true);

    const video = videoPart("video/mp4", "videodata...");
    expect(video.type).toBe("video");
    expect(ContentPartSchema.safeParse(video).success).toBe(true);
  });

  it("creates and validates file content parts", () => {
    const file = filePart("report.pdf", "application/pdf", {
      size: 1024,
      uri: "file:///path/to/report.pdf",
    });
    expect(file.type).toBe("file");
    expect(file.name).toBe("report.pdf");
    expect(ContentPartSchema.safeParse(file).success).toBe(true);
  });

  it("creates and validates tool_call and tool_result parts", () => {
    const callId = createToolCallId();
    const call = toolCallPart(callId, "read_file", { path: "package.json" });
    expect(isToolCallPart(call)).toBe(true);
    expect(call.toolName).toBe("read_file");
    expect(ContentPartSchema.safeParse(call).success).toBe(true);

    const result = toolResultPart(callId, { contents: "file content" }, false);
    expect(isToolResultPart(result)).toBe(true);
    expect(result.toolCallId).toBe(callId);
    expect(ContentPartSchema.safeParse(result).success).toBe(true);
  });

  it("rejects invalid content parts in schema validation", () => {
    expect(ContentPartSchema.safeParse({ type: "unknown_type" }).success).toBe(false);
    expect(ContentPartSchema.safeParse({ type: "text" }).success).toBe(false); // missing text
    expect(ContentPartSchema.safeParse({ type: "image", mimeType: "" }).success).toBe(false); // missing data
  });
});
