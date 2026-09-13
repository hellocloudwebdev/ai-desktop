// PR32: packages/plugins — Extension Capabilities (closed enum)
//
// Invariants:
//   1. EXTENSION_CAPABILITIES is a CLOSED enum: unknown capabilities are rejected.
//   2. normalizeCapabilities dedupes and sorts for stable hashes and comparisons.
//   3. Capabilities are declarations, NOT permissions: an extension cannot
//      self-grant permissions by declaring a capability.

import { z } from "zod";

export const EXTENSION_CAPABILITIES = [
  "tool.register",
  "workspace.view",
  "conversation.read",
  "conversation.write",
  "project.read",
  "filesystem.read",
  "filesystem.write",
  "execution.run",
  "network.request",
  "secrets.use",
  "memory.read",
] as const;

export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

export const ExtensionCapabilitySchema = z.enum(EXTENSION_CAPABILITIES);

const CAPABILITY_SET = new Set<string>(EXTENSION_CAPABILITIES);

/**
 * Dedupes and sorts capabilities for stable comparison and hashing.
 */
export function normalizeCapabilities(caps: readonly string[]): string[] {
  return [...new Set(caps)].sort();
}

/**
 * Rejects unknown capability strings against the closed enum.
 * Returns the list of unknown values (empty when all are known).
 */
export function validateCapabilities(caps: readonly string[]): string[] {
  return caps.filter((c) => !CAPABILITY_SET.has(c));
}
