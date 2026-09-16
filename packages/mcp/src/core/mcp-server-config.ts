// PR25.3 + PR38: packages/mcp — MCP Server Configuration
//
// Invariants:
//   1. Supports MCP transports: stdio, sse, streamable-http, and in_memory
//      (for fast in-process tests). "streamable-http" matches the ai-core
//      MCPTransport canonical spelling; the legacy "in_memory" underscore
//      spelling is preserved for backward compatibility.
//   2. Zero raw secrets stored in config: tokens/keys must use credential
//      references. Env values may be plain strings or secret-reference
//      objects of the form { secretRef: "<ref>" }; the host resolves those
//      via an injected SecretStore at connect time. The "secretRef:" string
//      prefix form is NOT supported (structured objects only, so a literal
//      env value can never be mistaken for a reference).
//   3. Config is validated with Zod at runtime before connection attempt.
//   4. Remote URLs (sse / streamable-http) must be http(s) with no embedded
//      credentials.

import { z } from "zod";

export const McpTransportTypeSchema = z.enum(["stdio", "sse", "in_memory", "streamable-http"]);
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

export const McpEnvSecretRefSchema = z.object({
  secretRef: z.string().trim().min(1, "secretRef must not be empty"),
});
export type McpEnvSecretRef = z.infer<typeof McpEnvSecretRefSchema>;

/** Env value: a literal string, or a { secretRef } object resolved at connect. */
export const McpEnvValueSchema = z.union([z.string(), McpEnvSecretRefSchema]);
export type McpEnvValue = z.infer<typeof McpEnvValueSchema>;

/** Type guard for secret-reference env values. */
export function isMcpEnvSecretRef(value: unknown): value is McpEnvSecretRef {
  return McpEnvSecretRefSchema.safeParse(value).success;
}

function isValidRemoteUrl(value: string | undefined): boolean {
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  // Embedded credentials (user:pass@host) are forbidden: use secretRef env
  // entries or headers resolved from the secret store instead.
  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  return true;
}
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
    // NOTE: env applies to the stdio transport only (child process
    // environment). Values are literal strings or { secretRef } objects
    // resolved via SecretStore at connect; other transports ignore env.
    env: z.record(z.string(), McpEnvValueSchema).optional(),
    cwd: z.string().optional(),
    // SSE / streamable-http options (shared `url`; validated below)
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
      if (cfg.transport === "streamable-http" && !cfg.url) {
        return false;
      }
      return true;
    },
    {
      message:
        "Transport requires matching configuration (command for stdio, url for sse/streamable-http)",
    },
  )
  .refine((cfg) => cfg.transport !== "sse" || isValidRemoteUrl(cfg.url), {
    message: "SSE url must be http(s) with no embedded credentials",
  })
  .refine((cfg) => cfg.transport !== "streamable-http" || isValidRemoteUrl(cfg.url), {
    message: "streamable-http url must be http(s) with no embedded credentials",
  })
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
