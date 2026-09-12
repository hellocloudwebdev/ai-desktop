// PR25.3: packages/mcp — MCP Server Configuration
//
// Invariants:
//   1. Supports MCP v2 transports: stdio, sse, and in_memory (for fast in-process tests).
//   2. Zero raw secrets stored in config: tokens/keys must use credential references.
//   3. Config is validated with Zod at runtime before connection attempt.

import { z } from "zod";

export const McpTransportTypeSchema = z.enum(["stdio", "sse", "in_memory"]);
export type McpTransportType = z.infer<typeof McpTransportTypeSchema>;

const FORBIDDEN_RAW_KEYS = [
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "password",
  "secret",
  "authorization",
];

function containsRawSecretKey(obj: Record<string, unknown> | undefined): boolean {
  if (!obj) return false;
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_RAW_KEYS.includes(lower)) {
      return true;
    }
  }
  return false;
}

export const McpServerConfigSchema = z
  .object({
    id: z.string().trim().min(1, "Server ID must not be empty"),
    name: z.string().trim().min(1, "Server name must not be empty"),
    transport: McpTransportTypeSchema,
    // Stdio options
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    // SSE options
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // In-memory options (used for testing or in-process servers)
    inMemoryServer: z.unknown().optional(),
    timeoutMs: z.number().int().positive().optional(),
    disabled: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (cfg) => {
      if (cfg.transport === "stdio" && !cfg.command) {
        return false;
      }
      if (cfg.transport === "sse" && !cfg.url) {
        return false;
      }
      return true;
    },
    { message: "Transport requires matching configuration (command for stdio, url for sse)" },
  )
  .refine(
    (cfg) =>
      !containsRawSecretKey(cfg.env as Record<string, unknown>) &&
      !containsRawSecretKey(cfg.headers as Record<string, unknown>),
    {
      message:
        "Raw credentials (apiKey, accessToken, secret, password) are forbidden in server config",
    },
  );

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
