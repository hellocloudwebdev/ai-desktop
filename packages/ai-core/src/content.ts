// PR4: packages/ai-core — Canonical Content Model
//
// Domain-level multimodal content parts. Decoupled from any provider-specific
// API representations (Anthropic, OpenAI, etc. must map to/from these types).

import { z } from "zod";
import type { ToolCallId } from "@ai-desktop/shared";
import { ToolCallIdSchema } from "@ai-desktop/shared";

// ---------------------------------------------------------------------------
// Schemas & Types for Canonical Content Parts
// ---------------------------------------------------------------------------

export const TextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export type TextContent = z.infer<typeof TextContentSchema>;

export const ImageContentSchema = z.object({
  type: z.literal("image"),
  mimeType: z.string().min(1),
  data: z.string().min(1), // Base64 data or URI
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  alt: z.string().optional(),
});

export type ImageContent = z.infer<typeof ImageContentSchema>;

export const AudioContentSchema = z.object({
  type: z.literal("audio"),
  mimeType: z.string().min(1),
  data: z.string().min(1), // Base64 data or URI
  format: z.string().optional(),
});

export type AudioContent = z.infer<typeof AudioContentSchema>;

export const VideoContentSchema = z.object({
  type: z.literal("video"),
  mimeType: z.string().min(1),
  data: z.string().min(1), // Base64 data or URI
});

export type VideoContent = z.infer<typeof VideoContentSchema>;

export const FileContentSchema = z.object({
  type: z.literal("file"),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
  uri: z.string().optional(),
  data: z.string().optional(), // Base64 data if embedded inline
});

export type FileContent = z.infer<typeof FileContentSchema>;

export const ToolCallContentSchema = z.object({
  type: z.literal("tool_call"),
  toolCallId: ToolCallIdSchema,
  toolName: z.string().min(1),
  arguments: z.unknown(),
});

export type ToolCallContent = z.infer<typeof ToolCallContentSchema>;

export const ToolResultContentSchema = z.object({
  type: z.literal("tool_result"),
  toolCallId: ToolCallIdSchema,
  result: z.unknown(),
  isError: z.boolean().optional(),
});

export type ToolResultContent = z.infer<typeof ToolResultContentSchema>;

export const ContentPartSchema = z.discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema,
  VideoContentSchema,
  FileContentSchema,
  ToolCallContentSchema,
  ToolResultContentSchema,
]);

export type ContentPart = z.infer<typeof ContentPartSchema>;

// ---------------------------------------------------------------------------
// Constructors & Type Guards
// ---------------------------------------------------------------------------

export function textPart(text: string): TextContent {
  return { type: "text", text };
}

export function imagePart(
  mimeType: string,
  data: string,
  options?: { width?: number; height?: number; alt?: string },
): ImageContent {
  return { type: "image", mimeType, data, ...options };
}

export function audioPart(mimeType: string, data: string, format?: string): AudioContent {
  return { type: "audio", mimeType, data, format };
}

export function videoPart(mimeType: string, data: string): VideoContent {
  return { type: "video", mimeType, data };
}

export function filePart(
  name: string,
  mimeType: string,
  options?: { size?: number; uri?: string; data?: string },
): FileContent {
  return { type: "file", name, mimeType, ...options };
}

export function toolCallPart(
  toolCallId: ToolCallId,
  toolName: string,
  args: unknown,
): ToolCallContent {
  return { type: "tool_call", toolCallId, toolName, arguments: args };
}

export function toolResultPart(
  toolCallId: ToolCallId,
  result: unknown,
  isError = false,
): ToolResultContent {
  return { type: "tool_result", toolCallId, result, isError };
}

export function isTextPart(part: ContentPart): part is TextContent {
  return part.type === "text";
}

export function isImagePart(part: ContentPart): part is ImageContent {
  return part.type === "image";
}

export function isToolCallPart(part: ContentPart): part is ToolCallContent {
  return part.type === "tool_call";
}

export function isToolResultPart(part: ContentPart): part is ToolResultContent {
  return part.type === "tool_result";
}
