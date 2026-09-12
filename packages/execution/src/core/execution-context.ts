// PR27.4: packages/execution — Execution Contract
//
// Invariants:
//   1. Execution represents a single command / process invocation.
//   2. ExecutionId uses canonical branded ULID from @ai-desktop/ai-core.
//   3. Statuses distinguish: pending, running, completed, failed, cancelled, timed_out.
//   4. Preserves stdout and stderr independently.

import { z } from "zod";
import type { ExecutionId, SessionId } from "@ai-desktop/ai-core";

export const ExecutionStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export interface ExecutionRecord {
  readonly id: ExecutionId;
  readonly sessionId: SessionId;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  status: ExecutionStatus;
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
  readonly startedAt: number;
  completedAt?: number;
  timedOut: boolean;
  error?: string;
}
