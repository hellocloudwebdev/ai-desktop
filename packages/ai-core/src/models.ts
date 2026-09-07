// PR10: packages/ai-core — Canonical Model & Provider Contracts
//
// Architectural Invariants:
//   1. Provider and Model are separate (Provider = service/backend, ModelDefinition = model + capabilities).
//   2. ModelDefinition owns capabilities (models differ even under the same provider).
//   3. Canonical ChatRequest is provider-neutral (no Anthropic/OpenAI SDK types).
//   4. Provider SDK types never escape into ai-core.
//   5. Cancellation uses standard AbortSignal.

import { z } from "zod";
import type { ConversationId, MessageId } from "@ai-desktop/shared";
import { ConversationIdSchema, MessageIdSchema } from "@ai-desktop/shared";
import type { ModelId, ProviderId } from "./identifiers.js";
import { ModelIdSchema, ProviderIdSchema } from "./identifiers.js";
import { type ContentPart, ContentPartSchema } from "./content.js";
import { type ToolDefinition, ToolDefinitionSchema } from "./tools.js";

// ---------------------------------------------------------------------------
// Model Capabilities
// ---------------------------------------------------------------------------

export const ModelCapabilitySchema = z.enum([
  "text_generation",
  "streaming",
  "vision",
  "audio",
  "video",
  "tool_use",
  "thinking",
  "structured_output",
]);

export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

// ---------------------------------------------------------------------------
// Model Definition
// ---------------------------------------------------------------------------

export const ModelDefinitionSchema = z.object({
  id: ModelIdSchema,
  providerId: ProviderIdSchema,
  displayName: z.string().min(1),
  description: z.string().optional(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilities: z.array(ModelCapabilitySchema).min(1),
  pricing: z
    .object({
      inputTokensPerDollar: z.number().positive().optional(),
      outputTokensPerDollar: z.number().positive().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ModelDefinition = {
  readonly id: ModelId;
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly description?: string;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly capabilities: readonly ModelCapability[];
  readonly pricing?: {
    readonly inputTokensPerDollar?: number;
    readonly outputTokensPerDollar?: number;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
};

// ---------------------------------------------------------------------------
// Canonical Chat Request
// ---------------------------------------------------------------------------

export const ChatMessageInputSchema = z.object({
  id: MessageIdSchema.optional(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.array(ContentPartSchema).min(1),
});

export type ChatMessageInput = {
  readonly id?: MessageId;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: readonly ContentPart[];
};

export const ChatRequestOptionsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  stopSequences: z.array(z.string()).optional(),
  thinking: z
    .object({
      enabled: z.boolean(),
      budgetTokens: z.number().int().positive().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ChatRequestOptions = z.infer<typeof ChatRequestOptionsSchema>;

/**
 * Canonical chat request submitted to a ProviderAdapter.
 * Purely provider-neutral: translated by the adapter into provider-native requests.
 */
export const ChatRequestSchema = z.object({
  conversationId: ConversationIdSchema,
  modelId: ModelIdSchema,
  messages: z.array(ChatMessageInputSchema).min(1),
  systemPrompt: z.string().optional(),
  tools: z.array(ToolDefinitionSchema).optional(),
  options: ChatRequestOptionsSchema.optional(),
});

export type ChatRequest = {
  readonly conversationId: ConversationId;
  readonly modelId: ModelId;
  readonly messages: readonly ChatMessageInput[];
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolDefinition[];
  readonly options?: ChatRequestOptions;
};
