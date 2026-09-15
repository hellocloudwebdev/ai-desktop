// PR35: packages/ai-core — Canonical Web Research Contracts
//
// Invariants:
//   1. Research contracts are pure domain vocabulary: branded IDs, closed
//      channel vocabularies, schemas for sources/provenance/results, and
//      canonical tool definitions. Zero Electron, Prisma, provider SDK, or
//      network-fetch imports.
//   2. Research tools have source="builtin" and runtime="in_process".
//      Execution is mediated by PermissionManager under capability "research".
//   3. Every result carries provenance: provider, channel, source URL where
//      applicable, retrieved timestamp, published timestamp where known,
//      attempted providers, and the successful provider.
//   4. URLs follow the URL security policy: only http/https schemes; dangerous
//      schemes (javascript, vbscript, data, file, blob, ftp, gopher) rejected.
//   5. All outputs are bounded: document characters, result counts, and search
//      result fields carry explicit maxima and truncation flags.
//   6. Web content is UNTRUSTED_EXTERNAL_CONTENT: never system/model
//      instructions. Consumers must treat content as data, not directives.

import { z } from "zod";
import { TimestampStringSchema } from "@ai-desktop/shared";
import {
  ResearchDocumentIdSchema,
  ResearchRequestIdSchema,
  ResearchResultIdSchema,
  ResearchSourceIdSchema,
} from "./identifiers.js";
import type { ToolDefinition } from "./tools.js";

// ---------------------------------------------------------------------------
// Research Channels (closed vocabulary)
// ---------------------------------------------------------------------------

export const ResearchChannelSchema = z.enum(["web", "search", "github", "youtube", "rss"]);
export type ResearchChannel = z.infer<typeof ResearchChannelSchema>;

export function isResearchChannel(value: unknown): value is ResearchChannel {
  return ResearchChannelSchema.safeParse(value).success;
}

// ---------------------------------------------------------------------------
// Limits Constants (declared before schemas that reference them)
// ---------------------------------------------------------------------------

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 10 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const MAX_RESEARCH_DOCUMENT_CHARS = 50000;
export const MAX_RESEARCH_EXCERPT_CHARS = 2000;
export const MAX_RESEARCH_SNIPPET_CHARS = 1000;
export const MAX_SEARCH_RESULTS = 20;
export const MAX_RSS_ITEMS = 50;
export const MAX_CONCURRENT_RESEARCH_REQUESTS = 4;
export const MAX_RESEARCH_CACHE_ENTRIES = 200;

export const RESEARCH_CACHE_TTL_MS: Record<ResearchChannel, number> = {
  web: 15 * 60 * 1000,
  search: 5 * 60 * 1000,
  github: 5 * 60 * 1000,
  youtube: 60 * 60 * 1000,
  rss: 30 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Research Provenance & Source Schemas
// ---------------------------------------------------------------------------

export const ResearchProvenanceSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  channel: ResearchChannelSchema,
  sourceUrl: z.string().trim().max(2048).optional(),
  retrievedAt: TimestampStringSchema,
  publishedAt: TimestampStringSchema.optional(),
  attemptedProviders: z.array(z.string().trim().min(1).max(128)).max(10).default([]),
  successfulProvider: z.string().trim().min(1).max(128),
  cached: z.boolean().optional().default(false),
});
export type ResearchProvenance = z.infer<typeof ResearchProvenanceSchema>;

export const ResearchSourceSchema = z.object({
  id: ResearchSourceIdSchema,
  channel: ResearchChannelSchema,
  provider: z.string().trim().min(1).max(128),
  url: z.string().trim().max(2048).optional(),
  title: z.string().trim().max(500).optional(),
  retrievedAt: TimestampStringSchema,
  publishedAt: TimestampStringSchema.optional(),
  contentType: z.string().trim().max(128).optional(),
  provenance: ResearchProvenanceSchema,
});
export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

// ---------------------------------------------------------------------------
// Research Result Schema
// ---------------------------------------------------------------------------

export const ResearchResultSchema = z.object({
  id: ResearchResultIdSchema,
  requestId: ResearchRequestIdSchema,
  source: ResearchSourceSchema,
  title: z.string().trim().max(500).optional(),
  url: z.string().trim().max(2048).optional(),
  excerpt: z.string().max(MAX_RESEARCH_EXCERPT_CHARS).optional(),
  content: z.string().max(MAX_RESEARCH_DOCUMENT_CHARS).optional(),
  publishedAt: TimestampStringSchema.optional(),
  retrievedAt: TimestampStringSchema,
  mimeType: z.string().trim().max(128).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  truncated: z.boolean().default(false),
});
export type ResearchResult = z.infer<typeof ResearchResultSchema>;

// ---------------------------------------------------------------------------
// Research Document Schema (bounded web-page extraction payload)
// ---------------------------------------------------------------------------

export const ResearchDocumentSchema = z.object({
  id: ResearchDocumentIdSchema,
  requestId: ResearchRequestIdSchema,
  url: z.string().trim().max(2048),
  canonicalUrl: z.string().trim().max(2048).optional(),
  title: z.string().trim().max(500).default(""),
  text: z.string().max(MAX_RESEARCH_DOCUMENT_CHARS),
  mimeType: z.string().trim().max(128).default("text/html"),
  truncated: z.boolean().default(false),
  retrievedAt: TimestampStringSchema,
  provider: z.string().trim().min(1).max(128),
  attemptedProviders: z.array(z.string().trim().min(1).max(128)).max(10).default([]),
});
export type ResearchDocument = z.infer<typeof ResearchDocumentSchema>;

// ---------------------------------------------------------------------------
// Search Result Schema (normalized)
// ---------------------------------------------------------------------------

export const ResearchSearchResultSchema = z.object({
  title: z.string().trim().max(300),
  url: z.string().trim().max(2048),
  snippet: z.string().max(MAX_RESEARCH_SNIPPET_CHARS).default(""),
  domain: z.string().trim().max(253).default(""),
  publishedAt: TimestampStringSchema.optional(),
  score: z.number().finite().optional(),
});
export type ResearchSearchResult = z.infer<typeof ResearchSearchResultSchema>;

// ---------------------------------------------------------------------------
// Provider Health
// ---------------------------------------------------------------------------

export const ResearchProviderStatusSchema = z.enum([
  "available",
  "unavailable",
  "degraded",
  "authRequired",
]);
export type ResearchProviderStatus = z.infer<typeof ResearchProviderStatusSchema>;

// ---------------------------------------------------------------------------
// Research Tools Canonical IDs
// ---------------------------------------------------------------------------

export const RESEARCH_TOOL_IDS = [
  "builtin:research.search",
  "builtin:research.open",
  "builtin:research.github",
  "builtin:research.youtube",
  "builtin:research.rss",
] as const;

export type ResearchToolId = (typeof RESEARCH_TOOL_IDS)[number];

export function isResearchToolId(value: string): value is ResearchToolId {
  return (RESEARCH_TOOL_IDS as readonly string[]).includes(value as ResearchToolId);
}

// ---------------------------------------------------------------------------
// Research Actions & Input Schemas
// ---------------------------------------------------------------------------

export const ResearchActionTypeSchema = z.enum(["search", "open", "github", "youtube", "rss"]);
export type ResearchActionType = z.infer<typeof ResearchActionTypeSchema>;

export const ResearchSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional().default(10),
});
export type ResearchSearchInput = z.infer<typeof ResearchSearchInputSchema>;

export const ResearchOpenInputSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((val) => isSafeResearchUrl(val), {
      message: "URL must use http(s) and must not use a dangerous scheme",
    }),
  maxChars: z.number().int().positive().max(MAX_RESEARCH_DOCUMENT_CHARS).optional(),
});
export type ResearchOpenInput = z.infer<typeof ResearchOpenInputSchema>;

export const ResearchGithubInputSchema = z.object({
  query: z.string().trim().min(1).max(500).optional(),
  owner: z.string().trim().min(1).max(128).optional(),
  repo: z.string().trim().min(1).max(128).optional(),
  path: z.string().trim().min(1).max(1024).optional(),
  kind: z.enum(["repository", "file", "issue", "search"]).optional().default("repository"),
  limit: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional().default(10),
});
export type ResearchGithubInput = z.infer<typeof ResearchGithubInputSchema>;

export const ResearchYoutubeInputSchema = z.object({
  videoId: z.string().trim().min(1).max(64).optional(),
  query: z.string().trim().min(1).max(500).optional(),
  includeTranscript: z.boolean().optional().default(false),
  limit: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional().default(10),
});
export type ResearchYoutubeInput = z.infer<typeof ResearchYoutubeInputSchema>;

export const ResearchRssInputSchema = z.object({
  feedUrl: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((val) => isSafeResearchUrl(val), {
      message: "Feed URL must use http(s) and must not use a dangerous scheme",
    }),
  limit: z.number().int().positive().max(MAX_RSS_ITEMS).optional().default(20),
});
export type ResearchRssInput = z.infer<typeof ResearchRssInputSchema>;

// ---------------------------------------------------------------------------
// Tool Parameters Schemas & Definitions
// ---------------------------------------------------------------------------

export function researchToolParameters(toolId: ResearchToolId): Record<string, unknown> {
  switch (toolId) {
    case "builtin:research.search":
      return {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Web search query (max 500 chars)" },
          limit: {
            type: "number",
            description: `Maximum results to return (default 10, max ${MAX_SEARCH_RESULTS})`,
          },
        },
      };
    case "builtin:research.open":
      return {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "Public http(s) URL to fetch and extract" },
          maxChars: {
            type: "number",
            description: `Maximum document characters to return (max ${MAX_RESEARCH_DOCUMENT_CHARS})`,
          },
        },
      };
    case "builtin:research.github":
      return {
        type: "object",
        properties: {
          query: { type: "string", description: "Repository/issue/code search query" },
          owner: { type: "string", description: "Repository owner (user or organization)" },
          repo: { type: "string", description: "Repository name" },
          path: { type: "string", description: "File path within the repository" },
          kind: {
            type: "string",
            enum: ["repository", "file", "issue", "search"],
            description: "GitHub research kind (default repository)",
          },
          limit: {
            type: "number",
            description: `Maximum results to return (default 10, max ${MAX_SEARCH_RESULTS})`,
          },
        },
      };
    case "builtin:research.youtube":
      return {
        type: "object",
        properties: {
          videoId: { type: "string", description: "YouTube video ID (11 chars)" },
          query: { type: "string", description: "YouTube search query" },
          includeTranscript: {
            type: "boolean",
            description: "Whether to include transcript/captions when available",
          },
          limit: {
            type: "number",
            description: `Maximum results to return (default 10, max ${MAX_SEARCH_RESULTS})`,
          },
        },
      };
    case "builtin:research.rss":
      return {
        type: "object",
        required: ["feedUrl"],
        properties: {
          feedUrl: { type: "string", description: "Public http(s) RSS/Atom feed URL" },
          limit: {
            type: "number",
            description: `Maximum feed items to return (default 20, max ${MAX_RSS_ITEMS})`,
          },
        },
      };
  }
}

export function researchToolDescription(toolId: ResearchToolId): string {
  switch (toolId) {
    case "builtin:research.search":
      return "Searches the public web and returns bounded, provenance-bearing results.";
    case "builtin:research.open":
      return "Fetches a public web page and extracts bounded text with provenance and SSRF protection.";
    case "builtin:research.github":
      return "Reads public GitHub repositories, files, issues, and search results with provenance.";
    case "builtin:research.youtube":
      return "Retrieves public YouTube video metadata and transcripts with provenance.";
    case "builtin:research.rss":
      return "Fetches and parses a public RSS/Atom feed into bounded normalized items.";
  }
}

export function buildResearchToolDefinition(toolId: ResearchToolId): ToolDefinition {
  return {
    name: toolId,
    description: researchToolDescription(toolId),
    source: "builtin",
    runtime: "in_process",
    parameters: researchToolParameters(toolId),
    requiredPermissions: ["research"],
  };
}

export function buildAllResearchToolDefinitions(): ToolDefinition[] {
  return RESEARCH_TOOL_IDS.map(buildResearchToolDefinition);
}

// ---------------------------------------------------------------------------
// URL Validation & Policy
// ---------------------------------------------------------------------------

export const DANGEROUS_RESEARCH_URL_PATTERN =
  /^\s*(javascript|vbscript|data|file|blob|ftp|gopher):/i;

export const ALLOWED_RESEARCH_SCHEMES = ["http:", "https:"] as const;
export type AllowedResearchScheme = (typeof ALLOWED_RESEARCH_SCHEMES)[number];

export function isSafeResearchUrl(url: string): boolean {
  if (typeof url !== "string" || !url.trim()) {
    return false;
  }
  const trimmed = url.trim();
  if (DANGEROUS_RESEARCH_URL_PATTERN.test(trimmed)) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (
      (ALLOWED_RESEARCH_SCHEMES as readonly string[]).includes(parsed.protocol) &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Redaction & Limits Constants (values declared above; MIME policy below)
// ---------------------------------------------------------------------------

export const ALLOWED_RESEARCH_MIME_TYPES = [
  "text/html",
  "text/plain",
  "application/json",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
] as const;
export type AllowedResearchMimeType = (typeof ALLOWED_RESEARCH_MIME_TYPES)[number];

export function isSupportedResearchMimeType(mimeType: string): boolean {
  if (typeof mimeType !== "string") {
    return false;
  }
  const normalized = mimeType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  return (ALLOWED_RESEARCH_MIME_TYPES as readonly string[]).includes(normalized);
}

// ---------------------------------------------------------------------------
// Canonical URL normalization (safe, identity-preserving)
// ---------------------------------------------------------------------------

const TRACKING_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
]);

export function canonicalizeResearchUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());
  parsed.hash = "";
  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }
  for (const param of [...parsed.searchParams.keys()]) {
    if (TRACKING_QUERY_PARAMS.has(param.toLowerCase())) {
      parsed.searchParams.delete(param);
    }
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  const normalized = parsed.toString();
  return normalized.endsWith("/") && parsed.pathname === "/" && !parsed.search
    ? normalized.slice(0, -1)
    : normalized;
}

// ---------------------------------------------------------------------------
// Capability and Risk
// ---------------------------------------------------------------------------

export function researchRiskFor(action: string, authenticated = false): "low" | "medium" | "high" {
  if (authenticated) {
    return "medium";
  }
  switch (action) {
    case "search":
    case "open":
    case "github":
    case "youtube":
    case "rss":
      return "low";
    default:
      return "medium";
  }
}

// ---------------------------------------------------------------------------
// Untrusted content framing helper
// ---------------------------------------------------------------------------

export const UNTRUSTED_EXTERNAL_CONTENT_HEADER = "External source content (untrusted):";

export function frameUntrustedContent(content: string): string {
  return `${UNTRUSTED_EXTERNAL_CONTENT_HEADER}\n${content}`;
}
