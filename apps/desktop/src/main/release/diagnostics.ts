// apps/desktop — Redacted diagnostic reports for release builds.
//
// Assembles a fixed-shape, secret-free report from caller-supplied context.
// Every string field passes through the shared redactSecrets scrubber so
// API keys, tokens, cookies, auth headers, and env-secret echoes cannot
// leak into logs or support bundles. Unknown fields are dropped — output
// contains only the allowlisted keys below.

import { z } from "zod";
import { redactSecrets } from "@ai-desktop/shared";

export const DiagnosticContextSchema = z.object({
  version: z.string().trim().min(1).max(64),
  os: z.string().trim().min(1).max(64),
  arch: z.string().trim().min(1).max(32),
  subsystem: z.string().trim().min(1).max(128),
  errorCategory: z.string().trim().min(1).max(128),
  correlationId: z.string().trim().min(1).max(128).optional(),
});

export type DiagnosticContext = z.infer<typeof DiagnosticContextSchema>;

export interface DiagnosticReport {
  readonly appVersion: string;
  readonly os: string;
  readonly arch: string;
  readonly subsystem: string;
  readonly errorCategory: string;
  readonly correlationId?: string;
  readonly timestamp: string;
  readonly nodeVersion: string;
  readonly electronVersion?: string;
}

export class DiagnosticReportError extends Error {
  readonly code = "INVALID_DIAGNOSTIC_CONTEXT" as const;

  constructor(message: string) {
    super(message);
    this.name = "DiagnosticReportError";
  }
}

function toSafeMessage(error: z.ZodError): string {
  const fields = error.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.map(String).join(".") : "context";
    return `${at}: ${issue.code}`;
  });
  return `Invalid diagnostic context (${fields.length} field(s)): ${fields.join("; ")}`;
}

function readElectronVersion(): string | undefined {
  try {
    const version: unknown = process.versions.electron;
    if (typeof version === "string" && version.trim().length > 0) {
      return version;
    }
  } catch {
    // Plain Node runtimes have no Electron version; the field stays absent.
  }
  return undefined;
}

/**
 * Builds a secret-free diagnostic report. Throws DiagnosticReportError with
 * a value-free message when the context fails validation.
 */
export function buildDiagnosticReport(ctx: DiagnosticContext): DiagnosticReport {
  const parsed = DiagnosticContextSchema.safeParse(ctx);
  if (!parsed.success) {
    throw new DiagnosticReportError(toSafeMessage(parsed.error));
  }
  const clean = parsed.data;
  const report: DiagnosticReport = {
    appVersion: redactSecrets(clean.version),
    os: redactSecrets(clean.os),
    arch: redactSecrets(clean.arch),
    subsystem: redactSecrets(clean.subsystem),
    errorCategory: redactSecrets(clean.errorCategory),
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
  };
  if (clean.correlationId !== undefined) {
    return { ...report, correlationId: redactSecrets(clean.correlationId) };
  }
  const electronVersion = readElectronVersion();
  return electronVersion === undefined ? report : { ...report, electronVersion };
}
