// PR35.32: apps/desktop — Research End-to-End Workflow Tests
//
// Two real-architecture workflows (stub network edge, real everything else):
//   1. Agent search -> select result -> open -> structured result with
//      provenance, through AgentRuntime + DesktopToolRouter +
//      ResearchToolExecutor + ResearchService + PermissionManager.
//   2. Static-reader failure -> controlled browser fallback (stubbed
//      BrowserService boundary) -> result with browser provenance.
// No live internet. Browser fallback uses a stub implementing the
// BrowserFallbackLike boundary (production wires BrowserService).

import { describe, expect, it } from "vitest";
import { EventBus, AgentRuntime } from "@ai-desktop/agent-runtime";
import type { ModelTurnOutcome, ToolInvoker } from "@ai-desktop/agent-runtime";
import type {
  ConversationId,
  PermissionCheck,
  PermissionDecisionResult,
  ToolCallId,
  ToolResult,
} from "@ai-desktop/ai-core";
import { createConversationId, createToolCallId } from "@ai-desktop/shared";
import type { PermissionManager } from "@ai-desktop/permissions";
import { DesktopToolRouter } from "../main/agent/agent-service.js";
import { ResearchService } from "../main/research/research-service.js";
import { ResearchToolExecutor } from "../main/research/research-tool-executor.js";
import { StaticWebReader } from "../main/research/adapters/web/web-reader.js";
import { ExaSearchAdapter } from "../main/research/adapters/search/search-provider.js";
import { defaultResearchPolicy } from "../main/research/research-policy.js";
import { InMemoryEventRepository } from "./test-helpers.js";

class AllowAllPermissions implements PermissionManager {
  readonly checks: PermissionCheck[] = [];
  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push(request);
    return { kind: "allow" };
  }
  async resolve(): Promise<boolean> {
    return true;
  }
  async revoke(): Promise<number> {
    return 0;
  }
  getPendingRequest(): undefined {
    return undefined;
  }
  listPendingRequests(): readonly [] {
    return [];
  }
  async listActivePolicies(): Promise<readonly []> {
    return [];
  }
}

const ARTICLE_URL = "https://example.com/local-llm-guide";

function stubFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes("api.exa.ai")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Local LLM Inference Guide",
              url: `${ARTICLE_URL}?utm_source=exa`,
              text: "Run models locally with bounded memory.",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      "<html><head><title>Local LLM Inference Guide</title></head>" +
        "<body><main><article><p>Run models locally with bounded memory.</p></article></main></body></html>",
      { headers: { "content-type": "text/html" } },
    );
  }) as typeof fetch;
}

function buildStack(opts?: {
  reader?: StaticWebReader;
  browserFallback?: {
    openAndSnapshot: (
      url: string,
      o?: { signal?: AbortSignal; projectId?: string },
    ) => Promise<{ title: string; text: string; finalUrl: string }>;
  };
}): {
  router: DesktopToolRouter;
  permissions: AllowAllPermissions;
  service: ResearchService;
} {
  const policy = defaultResearchPolicy();
  const permissions = new AllowAllPermissions();
  const fetchFn = stubFetch();
  const resolveAll = async () => [{ address: "93.184.216.34", family: 4 }];
  const reader = opts?.reader ?? new StaticWebReader({ policy, fetchFn, resolveAll });
  const search = new ExaSearchAdapter({
    policy,
    fetchFn,
    resolveSecret: async () => "exa-key",
    apiKeyRef: "provider/search/exa/api-key",
  });
  const service = new ResearchService({
    policy,
    webReader: reader,
    searchProvider: search,
    fetchFn,
    resolveAll,
    ...(opts?.browserFallback ? { browserFallback: opts.browserFallback } : {}),
  });
  const executor = new ResearchToolExecutor({
    permissionManager: permissions,
    researchService: service,
  });
  const router = new DesktopToolRouter({
    permissionManager: permissions,
    researchExecutor: executor,
  });
  return { router, permissions, service };
}

class ScriptedResearchModelInvoker {
  private _step = 0;
  async chat(): Promise<ModelTurnOutcome> {
    const step = this._step++;
    if (step === 0) {
      return {
        transcript: "Searching for local LLM inference guides",
        toolCalls: [
          {
            toolCallId: createToolCallId(),
            toolName: "builtin:research.search",
            toolSource: "builtin",
            toolRuntime: "in_process",
            input: { query: "local LLM inference guide" },
          },
        ],
        completed: false,
      };
    }
    if (step === 1) {
      return {
        transcript: "Opening the guide",
        toolCalls: [
          {
            toolCallId: createToolCallId(),
            toolName: "builtin:research.open",
            toolSource: "builtin",
            toolRuntime: "in_process",
            input: { url: ARTICLE_URL },
          },
        ],
        completed: false,
      };
    }
    return {
      transcript: "According to the Local LLM Inference Guide, run models locally.",
      toolCalls: [],
      completed: true,
    };
  }
}

describe("apps/desktop: Research end-to-end (PR35.32)", () => {
  it("agent searches, opens, and synthesizes through the real tool router", async () => {
    const { router, permissions } = buildStack();
    const bus = new EventBus();
    const publishedTypes: string[] = [];
    bus.subscribe(async (e) => {
      publishedTypes.push((e as { type: string }).type);
    });
    const storage = new InMemoryEventRepository();

    const toolInvoker: ToolInvoker = {
      invoke: async (
        toolName: string,
        input: unknown,
        context: { toolCallId: ToolCallId; projectId?: string; conversationId: ConversationId },
        signal?: AbortSignal,
      ): Promise<ToolResult> => router.invoke(toolName, input, context, signal),
    };

    const runtime = new AgentRuntime({
      modelInvoker: new ScriptedResearchModelInvoker() as never,
      toolInvoker,
      eventSink: {
        publish: async (event: object) => {
          await storage.append(event as never);
          await bus.publish(event as never);
        },
      } as never,
      permissionGateway: { isBlocked: async () => false } as never,
      maxNodeIterations: 10,
    });

    const conversationId = createConversationId();
    const taskResult = await runtime.runTask({
      conversationId,
      goal: "Find the latest guidance on local LLM inference",
      projectId: "research-e2e-project",
    });

    expect(taskResult.status).toBe("completed");
    if (taskResult.status === "completed") {
      expect(taskResult.summary).toContain("Local LLM");
    }

    // Universal lifecycle verified: gateway + executor permission checks.
    const researchChecks = permissions.checks.filter((c) => c.capability === "research");
    expect(researchChecks.map((c) => c.action).sort()).toEqual(["open", "search"]);
    for (const check of researchChecks) {
      expect(check.scope).toBe("once");
      expect(check.relatedToolCallIds.length).toBeGreaterThan(0);
    }
    expect(publishedTypes.length).toBeGreaterThan(0);
  });

  it("static failure routes to browser fallback with full provenance", async () => {
    const policy = defaultResearchPolicy();
    const failingReader = new StaticWebReader({
      policy,
      fetchFn: (async () => {
        throw new Error("JS-heavy page requires rendering");
      }) as typeof fetch,
      resolveAll: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const seen: string[] = [];
    const { router } = buildStack({
      reader: failingReader,
      browserFallback: {
        openAndSnapshot: async (url: string) => {
          seen.push(url);
          return {
            title: "Rendered Guide",
            text: "rendered content with complete article text ".repeat(10),
            finalUrl: url,
          };
        },
      },
    });

    const outcome = await router.invoke(
      "builtin:research.open",
      { url: ARTICLE_URL },
      {
        toolCallId: createToolCallId(),
        projectId: "research-fallback-project",
        conversationId: createConversationId(),
      },
    );
    expect(outcome.isError).toBe(false);
    expect(seen).toEqual([ARTICLE_URL]);
    const payload = JSON.parse(String(outcome.result)) as {
      source: { provider: string; provenance: { attemptedProviders: string[] } };
      title: string;
    };
    expect(payload.source.provider).toBe("browser");
    expect(payload.source.provenance.attemptedProviders).toEqual(["static-reader", "browser"]);
    expect(payload.title).toBe("Rendered Guide");
  });
});
