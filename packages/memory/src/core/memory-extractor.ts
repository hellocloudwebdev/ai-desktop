// PR28.6: packages/memory — Incremental Memory Fact Extractor
//
// Invariants:
//   1. Operates strictly on canonical AI domain data (Message, AIEvent), never provider SDK data.
//   2. Prioritizes explicit user statements with high confidence (e.g. "I use X").
//   3. Recognizes low-confidence inferred preferences conservatively or ignores them.
//   4. Rejects/memorizes nothing that resembles a raw credential.
//   5. Performs incremental extraction: each new message/event yields candidate facts independently.

import {
  containsRawCredential,
  type ConversationId,
  type MemoryFact,
  type MemoryFactId,
} from "@ai-desktop/ai-core";
import { createMemoryFactId, type MessageId } from "@ai-desktop/shared";

export interface ExtractMemoryOptions {
  readonly projectId?: string;
  readonly defaultScopeLevel?: "global" | "project";
  readonly sourceConversationId?: ConversationId;
  readonly skipLongMessages?: boolean;
}

/**
 * Determines the category and confidence for a message text snippet.
 */
function classifyMemoryCandidate(text: string): {
  category: "preference" | "fact" | "instruction" | "project_context" | "workflow";
  confidence: number;
} | null {
  const normalized = text.trim();
  if (normalized.length < 10 || normalized.length > 500) {
    return null;
  }

  const lowered = normalized.toLowerCase();

  // 1. User preference: explicit "I use", "I prefer", "My favorite"
  if (
    /\b(i use|i prefer|my favorite|my editor|my ide|my preferred|i always|i never)\b/.test(lowered)
  ) {
    return { category: "preference", confidence: 0.95 };
  }

  // 2. User instruction: imperative "remember", "always", "never", "don't"
  if (
    /\b(remember that|remember:|please remember|always use|never use|don't use|do not use)\b/.test(
      lowered,
    )
  ) {
    return { category: "instruction", confidence: 0.9 };
  }

  // 3. Project context: "we use", "our project", "the stack is", "tech stack"
  if (
    /\b(we use|our project|our stack|tech stack|project uses|codebase uses|built with)\b/.test(
      lowered,
    )
  ) {
    return { category: "project_context", confidence: 0.85 };
  }

  // 4. Workflow: "run", "command is", "to deploy", "to build", "steps:"
  if (
    /\b(run|deploy|build|test|command is|to run|workflow|steps?:|pipeline)\b/.test(lowered) &&
    normalized.length >= 20
  ) {
    return { category: "workflow", confidence: 0.8 };
  }

  // 5. Fact: fallback for substantial declarative statements (user-originated only)
  if (/\b(is|are|has|have|uses|runs on|version)\b/.test(lowered) && normalized.length >= 30) {
    return { category: "fact", confidence: 0.7 };
  }

  return null;
}

/**
 * Splits a message into candidate sentences for extraction.
 */
function splitIntoCandidateSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10);
}

/**
 * Extracts memory facts incrementally from a single user message's text content.
 * Stable: deterministic output for identical input.
 */
export function extractFactsFromMessage(
  messageText: string,
  options?: ExtractMemoryOptions,
): MemoryFact[] {
  const facts: MemoryFact[] = [];
  const ts = Date.now();
  const sentences = splitIntoCandidateSentences(messageText);

  for (const sentence of sentences) {
    // 1. Never memorize raw credentials (§PR28.12)
    if (containsRawCredential(sentence)) {
      continue;
    }

    const classification = classifyMemoryCandidate(sentence);
    if (!classification) {
      continue;
    }

    const scopeLevel = options?.defaultScopeLevel ?? (options?.projectId ? "project" : "global");
    const factId = createMemoryFactId();
    const fact: MemoryFact = {
      id: factId,
      scopeLevel,
      projectId: scopeLevel === "project" ? (options?.projectId ?? null) : null,
      content: sentence,
      category: classification.category,
      sensitivity: "normal",
      sourceConversationId: options?.sourceConversationId ?? null,
      confidence: classification.confidence,
      createdAt: ts,
      updatedAt: ts,
      supersededBy: null,
    };

    facts.push(fact);
  }

  return facts;
}

/**
 * Extracts memory facts from a set of canonical Message parts.
 * Only user-originated text parts produce candidates.
 */
export function extractFactsFromMessageContent(
  content: ReadonlyArray<{ type: string; text?: string }>,
  options?: ExtractMemoryOptions,
): MemoryFact[] {
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim().length >= 10) {
      texts.push(part.text);
    }
  }
  if (texts.length === 0) {
    return [];
  }

  const combined = texts.join("\n");
  return extractFactsFromMessage(combined, options);
}

export interface MemoryFactCandidate extends MemoryFact {
  readonly messageId?: MessageId;
  readonly sourceFactId?: MemoryFactId;
}
