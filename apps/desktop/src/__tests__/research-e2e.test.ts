// PR35: apps/desktop — Research End-to-End Workflow Tests
//
// Scenario A (search -> open -> synthesize):
//   research.search -> select result -> research.open -> extract content ->
//   provenance-bearing structured result.
//
// Scenario B (static failure -> browser fallback):
//   research.open with an empty static reader -> BrowserService snapshot ->
//   result with attemptedProviders [static-reader, browser-fallback].
//
// Both run through the real ResearchToolExecutor + ResearchService +
// ResearchRouter + AllowAll PermissionManager. HTTP origins are local
// servers; the browser boundary is a stub BrowserService (no Puppeteer).

import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { type PermissionCheck, type PermissionDecisionResult } from "@ai-desktop/ai-core";
import { DEFAULT_RESEARCH_POLICY } from "../main/research/research-policy.js";
import { createToolCallId } from "@ai-desktop/shared";
import type { PermissionManager } from "@ai-desktop/permissions";
import type {
  AdapterContext,
  ResearchAdapter,
  WebReaderOutput,
} from "../main/research/adapters/adapter.js";
import type { ResearchChannel } from "@ai-desktop/ai-core";
import { createTimestamp } from "@ai-desktop/shared";
import { createResearchRequestId } from "@ai-desktop/shared";
import { StaticWebReaderAdapter } from "../main/research/adapters/web/web-reader.js";
import {
  SearchAdapter,
  type SearchProvider,
} from "../main/research/adapters/search/search-adapter.js";
import { ResearchRouter } from "../main/research/routing/research-router.js";
import { ResearchService } from "../main/research/research-service.js";
import { ResearchToolExecutor } from "../main/research/research-tool-executor.js";
import type { ResearchDocument } from "@ai-desktop/ai-core";

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

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

/** Permissive test resolver: maps every hostname to loopback. */
const loopbackResolver = {
  async lookup() {
    return [{ address: "127.0.0.1", family: 4 }];
  },
};

const ARTICLE_HTML = `<html><head><title>Local LLM Inference Guide</title>
<meta name="description" content="Running models locally"></head>
<body><main><h1>Local LLM Inference</h1>
<p>llama.cpp and Ollama enable local inference on consumer hardware.</p>
<p>Quantization reduces memory with modest quality loss.</p></main></body></html>`;

function stubBrowserService(snapshotText: string) {
  return {
    getOrCreateSession: async () => ({ id: "sess-1" }),
    manager: {
      openPage: async () => ({ id: "page-1" }),
      snapshot: async () => ({
        text: snapshotText,
        title: "JS App",
        url: "https://example.com/app",
      }),
      closePage: async () => undefined,
    },
  };
}

describe("research e2e: search -> open -> synthesize", () => {
  it("drives the full workflow through the tool executor with provenance", async () => {
    const { server, port } = await startServer((req, res) => {
      if (req.url === "/article") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(ARTICLE_HTML);
        return;
      }
      res.statusCode = 404;
      res.end("nope");
    });
    try {
      const articleUrl = `http://127.0.0.1:${port}/article`;

      const searchBackend: SearchProvider = {
        provider: "test-search",
        async search() {
          return [
            {
              title: "Local LLM Inference Guide",
              url: articleUrl,
              snippet: "Run models locally",
              domain: "127.0.0.1",
            },
          ];
        },
      };

      const router = new ResearchRouter();
      // Host-controlled test origin: the loopback allowlist is set by the
      // test host (never the model) so the local fixture server is reachable
      // while production defaults keep loopback SSRF-blocked.
      router.register(
        new StaticWebReaderAdapter({
          resolver: loopbackResolver,
          policy: { ...DEFAULT_RESEARCH_POLICY, allowedHosts: ["127.0.0.1"] },
        }),
      );
      router.register(new SearchAdapter({ provider: searchBackend }));
      const service = new ResearchService({ router });
      const permissions = new AllowAllPermissions();
      const executor = new ResearchToolExecutor({
        permissionManager: permissions,
        researchService: service,
      });

      // 1. Agent searches.
      const searchResult = await executor.execute(
        "builtin:research.search",
        { query: "local LLM inference", limit: 5 },
        { projectId: "e2e", toolCallId: createToolCallId() },
      );
      expect(searchResult.isError).toBe(false);
      const hits = JSON.parse(String(searchResult.result)) as Array<{ url?: string }>;
      expect(hits).toHaveLength(1);
      expect(hits[0]?.url).toBe(articleUrl);

      // 2. Agent opens the selected result.
      const openResult = await executor.execute(
        "builtin:research.open",
        { url: hits[0]?.url },
        { projectId: "e2e", toolCallId: createToolCallId() },
      );
      expect(openResult.isError).toBe(false);
      const doc = JSON.parse(String(openResult.result)) as {
        title?: string;
        content?: string;
        truncated?: boolean;
        source?: {
          channel?: string;
          provenance?: {
            provider?: string;
            successfulProvider?: string;
            attemptedProviders?: string[];
          };
        };
      };
      expect(doc.title).toBe("Local LLM Inference Guide");
      expect(doc.content).toContain("llama.cpp");
      expect(doc.truncated).toBe(false);
      expect(doc.source?.channel).toBe("web");
      expect(doc.source?.provenance?.successfulProvider).toBe("static-reader");

      // 3. Permission checks covered both tools under capability "research".
      expect(permissions.checks.map((c) => c.action).sort()).toEqual(["open", "search"]);
      expect(permissions.checks.every((c) => c.capability === "research")).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("research e2e: static failure -> browser fallback", () => {
  it("recovers through the browser boundary with full provenance", async () => {
    const emptyAdapter: ResearchAdapter = {
      provider: "static-reader",
      channel: "web" as ResearchChannel,
      async readWeb(url: string, c: AdapterContext): Promise<WebReaderOutput> {
        const document: ResearchDocument = {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
          requestId: c.requestId as never,
          url,
          title: "",
          text: "   ",
          mimeType: "text/html",
          truncated: false,
          retrievedAt: createTimestamp(),
          provider: "static-reader",
          attemptedProviders: ["static-reader"],
        };
        return { document };
      },
    };
    const router = new ResearchRouter();
    router.register(emptyAdapter);
    const service = new ResearchService({
      router,
      browserService: stubBrowserService("JS-rendered article body") as never,
    });
    const executor = new ResearchToolExecutor({
      permissionManager: new AllowAllPermissions(),
      researchService: service,
    });

    const result = await executor.execute(
      "builtin:research.open",
      { url: "https://example.com/app" },
      { projectId: "e2e", toolCallId: createToolCallId() },
    );
    expect(result.isError).toBe(false);
    const doc = JSON.parse(String(result.result)) as {
      content?: string;
      source?: { provenance?: { successfulProvider?: string; attemptedProviders?: string[] } };
      metadata?: { fallback?: boolean };
    };
    expect(doc.content).toBe("JS-rendered article body");
    expect(doc.source?.provenance?.successfulProvider).toBe("browser-fallback");
    expect(doc.source?.provenance?.attemptedProviders).toEqual([
      "static-reader",
      "browser-fallback",
    ]);
    expect(doc.metadata?.fallback).toBe(true);
    void createResearchRequestId;
  });
});
