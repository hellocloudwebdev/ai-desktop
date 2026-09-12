// PR28.2, PR28.3, PR28.4, PR28.12: packages/ai-core — Canonical Memory Contracts
//
// Invariants:
//   1. MemoryFact represents durable knowledge extracted from conversations/events.
//   2. Scope level is strictly "global" or "project":
//      - When scopeLevel === "project", projectId MUST be present.
//      - When scopeLevel === "global", projectId MUST be absent/null.
//   3. Categories: preference, fact, instruction, project_context, workflow.
//   4. Sensitivity: normal vs sensitive (sensitive facts never inject into prompts automatically).
//   5. Confidence: normalized numeric score 0.0 to 1.0.
//   6. Contradictions use supersededBy reference (never silently deleted).
//   7. Memory is not a secret store: raw credentials (API keys, tokens, private keys) are rejected.

import { z } from "zod";
import { ConversationIdSchema, type ConversationId } from "@ai-desktop/shared";
import { MemoryFactIdSchema, type MemoryFactId } from "./identifiers.js";

export const MemoryScopeLevelSchema = z.enum(["global", "project"]);
export type MemoryScopeLevel = z.infer<typeof MemoryScopeLevelSchema>;

export const MemoryCategorySchema = z.enum([
  "preference",
  "fact",
  "instruction",
  "project_context",
  "workflow",
]);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;

export const MemorySensitivitySchema = z.enum(["normal", "sensitive"]);
export type MemorySensitivity = z.infer<typeof MemorySensitivitySchema>;

const RAW_CREDENTIAL_PATTERN =
  /(?:sk-ant-[a-zA-Z0-9_-]{20,}|AIzaSy[a-zA-Z0-9_-]{30,}|Bearer\s+[a-zA-Z0-9._~+/-]{20,}|-----BEGIN\s+[A-Z\s]+PRIVATE\s+KEY-----|password\s*[:=]\s*[^\s]{6,})/i;

export function containsRawCredential(text: string): boolean {
  return RAW_CREDENTIAL_PATTERN.test(text);
}

export const MemoryFactSchema = z
  .object({
    id: MemoryFactIdSchema,
    scopeLevel: MemoryScopeLevelSchema,
    projectId: z.string().trim().min(1).nullable().optional(),
    content: z
      .string()
      .trim()
      .min(1, "Memory fact content cannot be empty")
      .max(2000, "Memory fact content exceeds 2000 characters limit"),
    category: MemoryCategorySchema,
    sensitivity: MemorySensitivitySchema.default("normal"),
    sourceConversationId: ConversationIdSchema.nullable().optional(),
    confidence: z.number().min(0).max(1).default(1.0),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
    supersededBy: MemoryFactIdSchema.nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (fact) => {
      // Scope validation invariant (§PR28.3)
      if (fact.scopeLevel === "project") {
        return typeof fact.projectId === "string" && fact.projectId.trim().length > 0;
      }
      return fact.projectId === null || fact.projectId === undefined;
    },
    {
      message:
        "projectId must be present when scopeLevel is 'project', and absent/null when scopeLevel is 'global'",
    },
  )
  .refine((fact) => !containsRawCredential(fact.content), {
    message:
      "Raw credentials (API keys, tokens, private keys, passwords) are strictly forbidden in memory facts (§PR28.12)",
  });

export type MemoryFact = z.infer<typeof MemoryFactSchema>;

export interface CreateMemoryFactInput {
  readonly id?: MemoryFactId;
  readonly scopeLevel: MemoryScopeLevel;
  readonly projectId?: string | null;
  readonly content: string;
  readonly category: MemoryCategory;
  readonly sensitivity?: MemorySensitivity;
  readonly sourceConversationId?: ConversationId | null;
  readonly confidence?: number;
  readonly metadata?: Record<string, unknown>;
}
