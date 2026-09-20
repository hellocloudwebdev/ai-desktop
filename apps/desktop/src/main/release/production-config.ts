// apps/desktop — Production release configuration gate.
//
// Validates the environment for packaged (production) builds before the app
// reads anything else. Fail-closed rules:
//   1. Production requires the absence of dev flags (VITE_DEV_SERVER_URL,
//      DEBUG). Their presence means a dev environment leaked into a release.
//   2. The loader never reads secrets: any secret-bearing key
//      (apiKey/secret/token/...) present in the provided mapping aborts the
//      load instead of copying credential material into configuration.
//   3. Malformed values throw with a safe message that names fields and
//      failure codes only — never environment values.
// Non-production environments pass through with best-effort defaults and no
// validation, so local development keeps working with dev servers and keys.

import { z } from "zod";
import { resolveAppDataDir } from "./app-data.js";

export const RELEASE_CHANNELS = ["stable", "beta", "nightly"] as const;

export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export const ChannelSchema = z.enum(RELEASE_CHANNELS);

export const BuildTimeConfigSchema = z.object({
  version: z.string().trim().min(1).max(64),
  channel: ChannelSchema,
  commit: z.string().trim().min(1).max(128).optional(),
  buildTimestamp: z.string().trim().min(1).max(64).optional(),
  platform: z.string().trim().min(1).max(32),
  arch: z.string().trim().min(1).max(32),
});

export type BuildTimeConfig = z.infer<typeof BuildTimeConfigSchema>;

export const RuntimeConfigSchema = z.object({
  dataDir: z.string().trim().min(1).max(1024),
  logLevel: z.enum(["debug", "info", "warn", "error"]),
  updateFeedUrl: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine(isHttpsUrl, { message: "Update feed URL must use https" })
    .optional(),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export const UserConfigSchema = z.object({
  autoUpdates: z.boolean(),
  updateChannel: ChannelSchema,
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

export const ProductionConfigSchema = z.object({
  build: BuildTimeConfigSchema,
  runtime: RuntimeConfigSchema,
  user: UserConfigSchema,
});

export type ProductionConfig = z.infer<typeof ProductionConfigSchema>;

export interface LoadedProductionConfig {
  readonly config: ProductionConfig;
  readonly isProduction: boolean;
}

export type ProductionConfigErrorCode =
  "DEV_FLAG_PRESENT" | "SECRET_KEYS_PRESENT" | "INVALID_CONFIG";

export class ProductionConfigError extends Error {
  readonly code: ProductionConfigErrorCode;

  constructor(code: ProductionConfigErrorCode, message: string) {
    super(message);
    this.name = "ProductionConfigError";
    this.code = code;
  }
}

/** Environment flags that must never be set in a production release. */
const DEV_ONLY_KEYS = ["VITE_DEV_SERVER_URL", "DEBUG"] as const;

/** Key names that indicate secret-bearing configuration. Never read them. */
const SECRET_KEY_PATTERN = /api[_-]?key|secret|token|password|passwd/i;

function isSet(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function parseBooleanString(value: unknown, fallback: boolean): boolean | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return undefined;
}

/**
 * Renders a zod failure as field paths plus issue codes only. Values are
 * never echoed, so environment contents cannot leak through error text.
 */
function toSafeMessage(error: z.ZodError): string {
  const fields = error.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.map(String).join(".") : "config";
    return `${at}: ${issue.code}`;
  });
  return `Invalid production configuration (${fields.length} field(s)): ${fields.join("; ")}`;
}

function parseChannelOrDefault(value: unknown, fallback: ReleaseChannel): ReleaseChannel {
  const parsed = ChannelSchema.safeParse(typeof value === "string" ? value.trim() : value);
  return parsed.success ? parsed.data : fallback;
}

/** Best-effort defaults for non-production runs. Never throws. */
function devPassthrough(env: NodeJS.ProcessEnv): ProductionConfig {
  const channel = parseChannelOrDefault(env.AI_DESKTOP_CHANNEL, "stable");
  return {
    build: {
      version: isSet(env.AI_DESKTOP_VERSION)
        ? env.AI_DESKTOP_VERSION.trim().slice(0, 64)
        : "0.0.0-dev",
      channel,
      commit: isSet(env.AI_DESKTOP_COMMIT) ? env.AI_DESKTOP_COMMIT.trim().slice(0, 128) : undefined,
      buildTimestamp: isSet(env.AI_DESKTOP_BUILD_TIMESTAMP)
        ? env.AI_DESKTOP_BUILD_TIMESTAMP.trim().slice(0, 64)
        : undefined,
      platform: process.platform,
      arch: process.arch,
    },
    runtime: {
      dataDir: isSet(env.AI_DESKTOP_DATA_DIR)
        ? env.AI_DESKTOP_DATA_DIR.trim().slice(0, 1024)
        : resolveAppDataDir({ env }),
      logLevel: "info",
      updateFeedUrl: undefined,
    },
    user: {
      autoUpdates: parseBooleanString(env.AI_DESKTOP_AUTO_UPDATES, true) ?? true,
      updateChannel: parseChannelOrDefault(env.AI_DESKTOP_UPDATE_CHANNEL, channel),
    },
  };
}

/**
 * Loads and validates release configuration from the given environment
 * mapping. Returns `{ config, isProduction }`. Throws ProductionConfigError
 * with a value-free message when production validation fails.
 */
export function loadProductionConfig(env: NodeJS.ProcessEnv = process.env): LoadedProductionConfig {
  const isProduction = env.NODE_ENV === "production";
  if (!isProduction) {
    return { config: devPassthrough(env), isProduction: false };
  }

  for (const key of DEV_ONLY_KEYS) {
    if (isSet(env[key])) {
      throw new ProductionConfigError(
        "DEV_FLAG_PRESENT",
        `Invalid production configuration: ${key} must not be set in production.`,
      );
    }
  }

  const secretKeys = Object.keys(env).filter(
    (key) => /^(AI_DESKTOP_|AI_)/i.test(key) && SECRET_KEY_PATTERN.test(key),
  );
  if (secretKeys.length > 0) {
    throw new ProductionConfigError(
      "SECRET_KEYS_PRESENT",
      "Invalid production configuration: secret-bearing configuration keys are present; refusing to load.",
    );
  }

  const buildChannel = isSet(env.AI_DESKTOP_CHANNEL) ? env.AI_DESKTOP_CHANNEL.trim() : "stable";
  const parsed = ProductionConfigSchema.safeParse({
    build: {
      version: env.AI_DESKTOP_VERSION,
      channel: buildChannel,
      commit: isSet(env.AI_DESKTOP_COMMIT) ? env.AI_DESKTOP_COMMIT.trim() : undefined,
      buildTimestamp: isSet(env.AI_DESKTOP_BUILD_TIMESTAMP)
        ? env.AI_DESKTOP_BUILD_TIMESTAMP.trim()
        : undefined,
      platform: isSet(env.AI_DESKTOP_PLATFORM) ? env.AI_DESKTOP_PLATFORM.trim() : process.platform,
      arch: isSet(env.AI_DESKTOP_ARCH) ? env.AI_DESKTOP_ARCH.trim() : process.arch,
    },
    runtime: {
      dataDir: isSet(env.AI_DESKTOP_DATA_DIR)
        ? env.AI_DESKTOP_DATA_DIR.trim()
        : resolveAppDataDir({ env }),
      logLevel: isSet(env.AI_DESKTOP_LOG_LEVEL)
        ? env.AI_DESKTOP_LOG_LEVEL.trim().toLowerCase()
        : "info",
      updateFeedUrl: isSet(env.AI_DESKTOP_UPDATE_FEED_URL)
        ? env.AI_DESKTOP_UPDATE_FEED_URL.trim()
        : undefined,
    },
    user: {
      autoUpdates: parseBooleanString(env.AI_DESKTOP_AUTO_UPDATES, true),
      updateChannel: isSet(env.AI_DESKTOP_UPDATE_CHANNEL)
        ? env.AI_DESKTOP_UPDATE_CHANNEL.trim()
        : buildChannel,
    },
  });
  if (!parsed.success) {
    throw new ProductionConfigError("INVALID_CONFIG", toSafeMessage(parsed.error));
  }
  return { config: parsed.data, isProduction: true };
}
