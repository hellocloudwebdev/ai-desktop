import { describe, expect, it } from "vitest";
import {
  PermissionDecisionSchema,
  PermissionRequestSchema,
  type PermissionDecision,
  type PermissionRequest,
} from "./permissions.js";
import { createPermissionRequestId, createToolCallId, now } from "@ai-desktop/shared";

describe("ai-core permissions: Permission Request Contracts", () => {
  it("enforces relatedToolCallIds on PermissionRequest", () => {
    const callId1 = createToolCallId();
    const callId2 = createToolCallId();

    const req: PermissionRequest = {
      id: createPermissionRequestId(),
      relatedToolCallIds: [callId1, callId2],
      capability: "file_system:write",
      action: "write",
      resource: "/workspace/config.json",
      scope: "session",
      risk: "high",
      status: "pending",
      reason: "Updating workspace build config",
      createdAt: now(),
    };

    expect(PermissionRequestSchema.safeParse(req).success).toBe(true);
  });

  it("rejects PermissionRequest with empty relatedToolCallIds", () => {
    const req = {
      id: createPermissionRequestId(),
      relatedToolCallIds: [], // must relate to at least one tool call
      capability: "file_system:write",
      action: "write",
      resource: "/file",
      scope: "once",
      risk: "low",
      status: "pending",
      createdAt: now(),
    };

    expect(PermissionRequestSchema.safeParse(req).success).toBe(false);
  });

  it("validates PermissionDecision", () => {
    const decision: PermissionDecision = {
      requestId: createPermissionRequestId(),
      decision: "granted",
      scope: "session",
      reason: "User confirmed in UI dialog",
      decidedAt: now(),
      decidedBy: "user",
    };

    expect(PermissionDecisionSchema.safeParse(decision).success).toBe(true);
  });
});
