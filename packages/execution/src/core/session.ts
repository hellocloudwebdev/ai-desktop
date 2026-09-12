// PR27.3: packages/execution — Session Contract
//
// Invariants:
//   1. Session != Execution:
//      - Session represents project, workspace, mounts, environment, and container state.
//      - Execution represents a single command / process invocation.
//   2. SessionId uses canonical branded ULID from @ai-desktop/ai-core.
//   3. Zero raw secret values in Session records.

import { z } from "zod";
import { SessionIdSchema, type SessionId } from "@ai-desktop/ai-core";

export const SessionSchema = z.object({
  id: SessionIdSchema,
  projectId: z.string().trim().min(1).optional(),
  workspacePath: z.string().trim().min(1, "workspacePath must not be empty"),
  workingDirectory: z.string().trim().default("/workspace"),
  environment: z.record(z.string(), z.string()).default({}),
  readOnlyWorkspace: z.boolean().default(true),
  networkAllowed: z.boolean().default(false),
  containerId: z.string().optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});

export type Session = z.infer<typeof SessionSchema>;

export interface CreateSessionOptions {
  readonly id?: SessionId;
  readonly projectId?: string;
  readonly workspacePath: string;
  readonly workingDirectory?: string;
  readonly environment?: Record<string, string>;
  readonly readOnlyWorkspace?: boolean;
  readonly networkAllowed?: boolean;
}
