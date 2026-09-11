// PR24: packages/permissions — Default Permission Manager Implementation
//
// Invariants (Step 33 / PR24):
//   1. Canonical 5-dimension evaluation: capability, action, resource, scope, risk.
//   2. Pure deterministic policy evaluation with explicit deny precedence.
//   3. Supports 4 canonical approval modes: allow_once, allow_session, allow_project, deny.
//   4. Session grants are strictly in-memory (disappear on app restart).
//   5. Project grants are persisted in SQLite scoped strictly to projectId.
//   6. All tool execution goes through this checkpoint.
//   7. Coalesces same-batch, same-capability requests with relatedToolCallIds.
//   8. Revocation resets policy so next request requires user approval; audit is never rewritten.
//   9. Zero raw credentials stored in policies, audit records, or events.
//  10. Idempotent resolution: safe to resolve repeatedly without conflicting state.

import type { z } from "zod";
import {
  createPermissionRequestId,
  generateUlid,
  now,
  ValidationError,
  type ConversationId,
} from "@ai-desktop/shared";
import {
  createEventId,
  PermissionCheckSchema,
  type AIEvent,
  type PermissionCheck,
  type PermissionDecisionResult,
  type PermissionDeniedEvent,
  type PermissionGrantedEvent,
  type PermissionPolicyChangedEvent,
  type PermissionRequest,
  type PermissionRequestId,
  type PermissionRequestedEvent,
  type PermissionRevokedEvent,
} from "@ai-desktop/ai-core";
import type { PermissionRepository } from "@ai-desktop/storage";
import type {
  CheckPermissionOptions,
  PermissionManager,
  ResolvePermissionInput,
  RevokePermissionInput,
} from "./permission-manager.js";
import type { PermissionPolicy } from "./permission-policy.js";
import { defaultPolicyEvaluator, PermissionPolicyEvaluator } from "./policy-evaluator.js";

export interface DefaultPermissionManagerOptions {
  readonly storage?: PermissionRepository;
  readonly evaluator?: PermissionPolicyEvaluator;
  readonly eventSink?: (event: Readonly<AIEvent>) => Promise<void> | void;
}

export class DefaultPermissionManager implements PermissionManager {
  private readonly _storage?: PermissionRepository;
  private readonly _evaluator: PermissionPolicyEvaluator;
  private readonly _eventSink?: (event: Readonly<AIEvent>) => Promise<void> | void;

  // In-memory state
  private readonly _pendingRequests = new Map<PermissionRequestId, PermissionRequest>();
  private readonly _sessionPolicies: PermissionPolicy[] = [];
  private readonly _onceApprovals = new Set<string>(); // authorized toolCallId strings for allow_once
  private readonly _coalescedBatches = new Map<string, PermissionRequest>();

  constructor(options?: DefaultPermissionManagerOptions) {
    this._storage = options?.storage;
    this._evaluator = options?.evaluator ?? defaultPolicyEvaluator;
    this._eventSink = options?.eventSink;
  }

  /**
   * Primary checkpoint evaluation.
   * Every privileged tool execution must call this method.
   */
  async check(
    request: PermissionCheck,
    options?: CheckPermissionOptions,
  ): Promise<PermissionDecisionResult> {
    // 1. Strict schema validation (§33)
    const parseResult = PermissionCheckSchema.safeParse(request);
    if (!parseResult.success) {
      const errorDetails = parseResult.error.issues
        .map((issue: z.ZodIssue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ");
      throw new ValidationError(`Invalid permission request: ${errorDetails}`, {
        details: parseResult.error.issues,
      });
    }
    const check = parseResult.data;

    // 2. Step A: Check allow_once authorization
    const allOnceAuthorized = check.relatedToolCallIds.every((id) => this._onceApprovals.has(id));
    if (allOnceAuthorized && check.relatedToolCallIds.length > 0) {
      // Consume the once-grants so they cannot be reused arbitrarily
      for (const id of check.relatedToolCallIds) {
        this._onceApprovals.delete(id);
      }
      await this._recordAudit({
        projectId: options?.projectId,
        conversationId: options?.conversationId,
        check,
        decision: "allow",
        decidedBy: "user",
        reason: "Authorized via allow_once",
      });
      return { kind: "allow" };
    }

    // 3. Step B: Collect active policies (session + persistent project)
    const activePolicies = await this.listActivePolicies(options?.projectId);

    // 4. Step C: Pure deterministic evaluation
    const evalResult = this._evaluator.evaluate(check, activePolicies);

    if (evalResult.kind === "allow") {
      await this._recordAudit({
        projectId: options?.projectId,
        conversationId: options?.conversationId,
        check,
        decision: "allow",
        decidedBy: "policy",
      });
      return { kind: "allow" };
    }

    if (evalResult.kind === "deny") {
      await this._recordAudit({
        projectId: options?.projectId,
        conversationId: options?.conversationId,
        check,
        decision: "deny",
        decidedBy: "policy",
        reason: evalResult.reason,
      });
      return { kind: "deny", reason: evalResult.reason };
    }

    // 5. Step D: Coalescing check (PR24.12)
    // Same batch + same capability + same scope + same resource -> coalesce
    if (options?.batchId) {
      const coalesceKey = `${options.batchId}:${check.capability}:${check.scope}:${check.resource}`;
      const existing = this._coalescedBatches.get(coalesceKey);
      if (existing && this._pendingRequests.has(existing.id)) {
        // Coalesce related tool call IDs
        const existingToolCalls = [...existing.relatedToolCallIds];
        for (const id of check.relatedToolCallIds) {
          if (!existingToolCalls.includes(id)) {
            existingToolCalls.push(id);
          }
        }
        const updatedRequest: PermissionRequest = {
          ...existing,
          relatedToolCallIds: existingToolCalls,
        };
        this._pendingRequests.set(existing.id, updatedRequest);
        this._coalescedBatches.set(coalesceKey, updatedRequest);
        return { kind: "requires_user", request: updatedRequest };
      }
    }

    // 6. Step E: Create new PermissionRequest
    const requestId = createPermissionRequestId();
    const permRequest: PermissionRequest = {
      id: requestId,
      relatedToolCallIds: [...check.relatedToolCallIds],
      capability: check.capability,
      action: check.action,
      resource: check.resource,
      scope: check.scope,
      risk: check.risk,
      status: "pending",
      reason: check.reason,
      createdAt: now(),
      metadata: {
        ...check.metadata,
        projectId: options?.projectId,
        conversationId: options?.conversationId,
      },
    };

    this._pendingRequests.set(requestId, permRequest);

    if (options?.batchId) {
      const coalesceKey = `${options.batchId}:${check.capability}:${check.scope}:${check.resource}`;
      this._coalescedBatches.set(coalesceKey, permRequest);
    }

    await this._recordAudit({
      projectId: options?.projectId,
      conversationId: options?.conversationId,
      permissionRequestId: requestId,
      check,
      decision: "requires_user",
      decidedBy: "policy",
    });

    // Emit canonical permission.requested event
    if (this._eventSink) {
      const event: PermissionRequestedEvent = {
        eventId: createEventId(),
        conversationId: (options?.conversationId ??
          createPermissionRequestId()) as unknown as ConversationId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "permission.requested",
        category: "capability",
        permissionRequestId: requestId,
        relatedToolCallIds: [...check.relatedToolCallIds],
        capability: check.capability,
        action: check.action,
        resource: check.resource,
        risk: check.risk,
        scope: check.scope,
      };
      await this._eventSink(event);
    }

    return { kind: "requires_user", request: permRequest };
  }

  /**
   * Resolves a pending permission request after user interaction.
   * Safe and idempotent.
   */
  async resolve(input: ResolvePermissionInput): Promise<boolean> {
    const request = this._pendingRequests.get(input.requestId);
    if (!request || request.status !== "pending") {
      return false; // Already resolved or unknown: idempotent exit
    }

    const isGranted = input.decision === "granted";
    this._pendingRequests.delete(input.requestId);

    const projectId = request.metadata?.projectId as string | undefined;

    // Apply approval scope decisions
    if (isGranted) {
      if (input.mode === "allow_once") {
        // Authorize strictly these related tool calls
        for (const id of request.relatedToolCallIds) {
          this._onceApprovals.add(id);
        }
      } else if (input.mode === "allow_session") {
        // Store in session in-memory policy
        const sessionPolicy: PermissionPolicy = {
          id: generateUlid(),
          projectId,
          capability: request.capability,
          action: request.action,
          resourcePattern: request.resource,
          decision: "allow",
          scope: "session",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        this._sessionPolicies.push(sessionPolicy);
        await this._emitPolicyChanged({
          capability: request.capability,
          action: "created",
          scope: "session",
          details: `Session policy created for ${request.capability}`,
        });
      } else if (input.mode === "allow_project") {
        // Persist project policy in SQLite storage
        if (this._storage) {
          await this._storage.savePolicy({
            id: generateUlid(),
            projectId: projectId ?? null,
            capability: request.capability,
            action: request.action,
            resourcePattern: request.resource,
            decision: "allow",
            scope: "project",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        await this._emitPolicyChanged({
          capability: request.capability,
          action: "created",
          scope: "project",
          details: `Project policy created for ${request.capability}`,
        });
      }
    } else {
      // User denied
      if (input.mode === "allow_project" || input.mode === "deny") {
        if (projectId && this._storage) {
          await this._storage.savePolicy({
            id: generateUlid(),
            projectId,
            capability: request.capability,
            action: request.action,
            resourcePattern: request.resource,
            decision: "deny",
            scope: "project",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        } else {
          this._sessionPolicies.push({
            id: generateUlid(),
            projectId,
            capability: request.capability,
            action: request.action,
            resourcePattern: request.resource,
            decision: "deny",
            scope: "session",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        await this._emitPolicyChanged({
          capability: request.capability,
          action: "created",
          details: `Deny policy created for ${request.capability}`,
        });
      }
    }

    // Record audit entry
    await this._recordAudit({
      projectId,
      conversationId: request.metadata?.conversationId as string | undefined,
      permissionRequestId: request.id,
      check: {
        capability: request.capability,
        action: request.action,
        resource: request.resource,
        scope: request.scope,
        risk: request.risk,
        relatedToolCallIds: [...request.relatedToolCallIds],
      },
      decision: isGranted ? "allow" : "deny",
      decidedBy: "user",
      reason: input.reason,
    });

    // Emit resolution event
    if (this._eventSink) {
      const convId = (request.metadata?.conversationId ??
        createPermissionRequestId()) as unknown as ConversationId;
      if (isGranted) {
        const event: PermissionGrantedEvent = {
          eventId: createEventId(),
          conversationId: convId,
          sequence: 0,
          schemaVersion: 1,
          timestamp: now(),
          type: "permission.granted",
          category: "capability",
          permissionRequestId: request.id,
          scope: request.scope,
          reason: input.reason,
        };
        await this._eventSink(event);
      } else {
        const event: PermissionDeniedEvent = {
          eventId: createEventId(),
          conversationId: convId,
          sequence: 0,
          schemaVersion: 1,
          timestamp: now(),
          type: "permission.denied",
          category: "capability",
          permissionRequestId: request.id,
          reason: input.reason,
        };
        await this._eventSink(event);
      }
    }

    return true;
  }

  /**
   * Revokes matching permission policies.
   * Historical audit records are never rewritten or removed.
   */
  async revoke(input: RevokePermissionInput): Promise<number> {
    let count = 0;

    // 1. Remove from in-memory session policies
    for (let i = this._sessionPolicies.length - 1; i >= 0; i--) {
      const policy = this._sessionPolicies[i];
      if (
        policy.capability === input.capability &&
        (!input.projectId || policy.projectId === input.projectId) &&
        (!input.resourcePattern || policy.resourcePattern === input.resourcePattern)
      ) {
        this._sessionPolicies.splice(i, 1);
        count++;
      }
    }

    // 2. Remove from persistent storage
    if (this._storage && (!input.scope || input.scope === "project")) {
      const criteria: {
        capability: string;
        projectId?: string | null;
        resourcePattern?: string | null;
      } = {
        capability: input.capability,
      };
      if (input.projectId !== undefined) {
        criteria.projectId = input.projectId;
      }
      if (input.resourcePattern !== undefined) {
        criteria.resourcePattern = input.resourcePattern;
      }
      const deletedFromDb = await this._storage.deletePoliciesByCriteria(criteria);
      count += deletedFromDb;
    }

    // 3. Emit canonical permission.revoked event
    if (this._eventSink) {
      const event: PermissionRevokedEvent = {
        eventId: createEventId(),
        conversationId: createPermissionRequestId() as unknown as ConversationId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "permission.revoked",
        category: "capability",
        capability: input.capability,
        resource: input.resourcePattern,
        reason: "User requested revocation",
      };
      await this._eventSink(event);
    }

    // 4. Emit policy changed event
    await this._emitPolicyChanged({
      capability: input.capability,
      action: "deleted",
      details: `Revoked policies for capability "${input.capability}"`,
    });

    return count;
  }

  getPendingRequest(requestId: PermissionRequestId): PermissionRequest | undefined {
    return this._pendingRequests.get(requestId);
  }

  listPendingRequests(): readonly PermissionRequest[] {
    return [...this._pendingRequests.values()];
  }

  /**
   * Lists combined active policies (session in-memory + persistent project).
   */
  async listActivePolicies(projectId?: string): Promise<readonly PermissionPolicy[]> {
    const nowMs = Date.now();
    const validSession = this._sessionPolicies.filter((p) => !p.expiresAt || p.expiresAt > nowMs);

    if (!this._storage) {
      return validSession;
    }

    const stored = await this._storage.findPolicies({
      projectId: projectId ?? undefined,
    });

    const mappedStored: PermissionPolicy[] = stored
      .filter((p) => !p.expiresAt || p.expiresAt > nowMs)
      .map((p) => ({
        id: p.id,
        projectId: p.projectId ?? undefined,
        capability: p.capability,
        action: p.action ?? undefined,
        resourcePattern: p.resourcePattern ?? undefined,
        decision: p.decision,
        scope: p.scope as import("@ai-desktop/ai-core").PermissionScope,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        expiresAt: p.expiresAt ?? undefined,
      }));

    return [...validSession, ...mappedStored];
  }

  private async _recordAudit(data: {
    projectId?: string;
    conversationId?: string;
    permissionRequestId?: string;
    check: PermissionCheck;
    decision: string;
    decidedBy: string;
    reason?: string;
  }): Promise<void> {
    if (!this._storage) {
      return;
    }

    try {
      await this._storage.recordAudit({
        id: generateUlid(),
        projectId: data.projectId ?? null,
        conversationId: data.conversationId ?? null,
        permissionRequestId: data.permissionRequestId ?? null,
        capability: data.check.capability,
        action: data.check.action,
        resource: data.check.resource,
        scope: data.check.scope,
        risk: data.check.risk,
        decision: data.decision,
        decidedBy: data.decidedBy,
        relatedToolCallIds: [...data.check.relatedToolCallIds],
        reason: data.reason ?? null,
        timestamp: Date.now(),
      });
    } catch {
      // Storage audit failure should not abort execution path
    }
  }

  private async _emitPolicyChanged(data: {
    capability: string;
    action: "created" | "updated" | "deleted";
    scope?: string;
    details?: string;
  }): Promise<void> {
    if (!this._eventSink) {
      return;
    }

    const event: PermissionPolicyChangedEvent = {
      eventId: createEventId(),
      conversationId: createPermissionRequestId() as unknown as ConversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "permission.policy.changed",
      category: "capability",
      capability: data.capability,
      action: data.action,
      scope: data.scope as import("@ai-desktop/ai-core").PermissionScope | undefined,
      details: data.details,
    };

    await this._eventSink(event);
  }
}
