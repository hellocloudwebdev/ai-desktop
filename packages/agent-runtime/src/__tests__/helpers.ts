// PR29.18: packages/agent-runtime — Shared Test Doubles
//
// Fake ModelInvoker / ToolInvoker / MemoryProvider / PermissionGateway / EventSink
// implementing the canonical runtime boundaries without any SDK, Docker, or storage.

import {
  type AIEvent,
  type ChatRequest,
  type ConversationId,
  type TaskNodeId,
  type ToolCallId,
  type ToolResult,
} from "@ai-desktop/ai-core";
import { createConversationId, createToolCallId, now } from "@ai-desktop/shared";
import type {
  EventSink,
  MemoryProvider,
  ModelInvoker,
  ModelTurnOutcome,
  PermissionGateway,
  RequestedToolCall,
  ToolInvoker,
} from "../runtime/types.js";

export interface ScriptedModelTurn {
  readonly transcript: string;
  readonly toolCalls?: readonly {
    readonly toolName: string;
    readonly toolSource?: string;
    readonly toolRuntime?: string;
    readonly input?: unknown;
  }[];
  readonly completed?: boolean;
}

export class FakeModelInvoker implements ModelInvoker {
  readonly requests: ChatRequest[] = [];
  private readonly _turns: ScriptedModelTurn[];
  private _cursor = 0;

  constructor(turns: readonly ScriptedModelTurn[] = [{ transcript: "Done." }]) {
    this._turns = [...turns];
  }

  async chat(request: ChatRequest): Promise<ModelTurnOutcome> {
    this.requests.push(request);
    const turn = this._turns[Math.min(this._cursor, this._turns.length - 1)];
    this._cursor += 1;
    const toolCalls: RequestedToolCall[] = (turn.toolCalls ?? []).map((t) => ({
      toolCallId: createToolCallId(),
      toolName: t.toolName,
      toolSource: t.toolSource ?? "builtin",
      toolRuntime: t.toolRuntime ?? "in_process",
      input: t.input ?? {},
    }));
    return {
      transcript: turn.transcript,
      toolCalls,
      completed: turn.completed ?? toolCalls.length === 0,
    };
  }
}

export class FakeToolInvoker implements ToolInvoker {
  readonly calls: Array<{ toolName: string; input: unknown; toolCallId: ToolCallId }> = [];
  private _behavior: (toolName: string, input: unknown) => ToolResult | Error | "blocked";

  constructor(behavior?: (toolName: string, input: unknown) => ToolResult | Error | "blocked") {
    this._behavior =
      behavior ??
      ((toolName: string) => ({
        toolCallId: createToolCallId(),
        toolName,
        result: `ok:${toolName}`,
        isError: false,
        timestamp: now(),
      }));
  }

  setBehavior(fn: (toolName: string, input: unknown) => ToolResult | Error | "blocked"): void {
    this._behavior = fn;
  }

  async invoke(
    toolName: string,
    input: unknown,
    context: { toolCallId: ToolCallId; projectId?: string; conversationId: ConversationId },
  ): Promise<ToolResult> {
    this.calls.push({ toolName, input, toolCallId: context.toolCallId });
    const outcome = this._behavior(toolName, input);
    if (outcome instanceof Error) throw outcome;
    if (outcome === "blocked") {
      throw new Error("Permission denied: blocked by test gateway");
    }
    return { ...outcome, toolCallId: context.toolCallId, toolName };
  }
}

export class FakeMemoryProvider implements MemoryProvider {
  readonly queries: Array<{ goal: string; projectId?: string }> = [];
  constructor(private readonly _text = "") {}

  async retrieveForTask(goal: string, projectId?: string): Promise<string> {
    this.queries.push({ goal, projectId });
    return this._text;
  }
}

export class FakePermissionGateway implements PermissionGateway {
  constructor(private readonly _blockedTools = new Set<string>()) {}

  block(toolName: string): void {
    this._blockedTools.add(toolName);
  }

  unblock(toolName: string): void {
    this._blockedTools.delete(toolName);
  }

  async isBlocked(toolName: string): Promise<boolean> {
    return this._blockedTools.has(toolName);
  }
}

export class RecordingEventSink implements EventSink {
  readonly events: AIEvent[] = [];

  async publish(event: Readonly<AIEvent>): Promise<void> {
    this.events.push(event as AIEvent);
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }

  count(type: string): number {
    return this.events.filter((e) => e.type === type).length;
  }
}

export function unusedConversation(): ConversationId {
  return createConversationId();
}

export function unusedNode(): TaskNodeId {
  return "01JAAAAAAAAAAAAAAAAAAAAAAAAA" as unknown as TaskNodeId;
}
