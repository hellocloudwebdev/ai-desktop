// PR36: apps/desktop — Deep Research End-to-End Workflow Tests
//
// E2E #1 (agent -> research.deep -> package -> workspace-ready data):
//   full multi-source run through the real ToolExecutor + Orchestrator +
//   ResearchService + Router, asserting the ResearchPackage handoff shape.
//
// E2E #2 (conflict): deterministic fixtures where Source A says X and
//   Source B says Y; exactly one conflict, neither source discarded.
//
// E2E #3 (browser fallback): static reader fails -> BrowserService snapshot
//   -> evidence + citation through the PR34 boundary.
//
// All origins are local servers or stub adapters — no live internet, no
// Puppeteer.

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
import type { ResearchChannel, ResearchDocument, ResearchPackage } from "@ai-desktop/ai-core";
import { createTimestamp } from "@ai-desktop/shared";
import { StaticWebReaderAdapter } from "../main/research/adapters/web/web-reader.js";
import {
  SearchAdapter,
  type SearchProvider,
} from "../main/research/adapters/search/search-adapter.js";
import { ResearchRouter } from "../main/research/routing/research-router.js";
import { ResearchService } from "../main/research/research-service.js";
import { ResearchToolExecutor } from "../main/research/research-tool-executor.js";

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

const GUIDE_HTML =
  `<html><head><title>Open-Source Agents Guide</title></head><body><main>` +
  `<h1>Open-Source Coding Agents</h1>` +
  `<p>Several open-source coding agents ship local inference support in 2026.</p>` +
  `<p>Benchmarks compare task completion across public repositories.</p>` +
  `</main></body></html>`;

const BENCH_HTML =
  `<html><head><title>Agent Benchmarks</title></head><body><main>` +
  `<h1>Coding Agent Benchmarks</h1>` +
  `<p>Recent releases improved completion rates on public benchmarks.</p>` +
  `<p>Independent comparisons rank agents by repair success.</p>` +
  `</main></body></html>`;

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

describe("research e2e #1: agent -> research.deep -> package", () => {
  it("runs multi-source synthesis and returns a workspace-ready package", async () => {
    const { server, port } = await startServer((req, res) => {
      if (req.url === "/guide") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(GUIDE_HTML);
        return;
      }
      if (req.url === "/bench") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(BENCH_HTML);
        return;
      }
      res.statusCode = 404;
      res.end("nope");
    });
    try {
      const guideUrl = `http://127.0.0.1:${port}/guide`;
      const benchUrl = `http://127.0.0.1:${port}/bench`;
      const searchBackend: SearchProvider = {
        provider: "test-search",
        async search() {
          return [
            {
              title: "Open-Source Agents Guide",
              url: guideUrl,
              snippet: "local inference",
              domain: "127.0.0.1",
            },
            {
              title: "Open-Source Agents Guide",
              url: `${guideUrl}?utm_source=x`,
              snippet: "local inference",
              domain: "127.0.0.1",
            },
            {
              title: "Agent Benchmarks",
              url: benchUrl,
              snippet: "completion rates",
              domain: "127.0.0.1",
            },
          ];
        },
      };

      const router = new ResearchRouter();
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

      const outcome = await executor.execute(
        "builtin:research.deep",
        { queries: ["open-source coding agents", "coding agent benchmarks"], depth: "standard" },
        { projectId: "e2e", toolCallId: createToolCallId() },
      );
      expect(outcome.isError).toBe(false);
      const pkg = JSON.parse(String(outcome.result)) as ResearchPackage;

      // Durable handoff shape for the Agent Runtime / Workspace.
      expect(pkg.version).toBe(1);
      expect(pkg.status).toBe("complete");
      expect(pkg.plan.steps).toHaveLength(2);
      expect(pkg.sources).toHaveLength(2);
      expect(pkg.evidence.length).toBeGreaterThan(0);
      expect(pkg.claims.length).toBe(pkg.evidence.length);
      expect(pkg.citations).toHaveLength(2);
      expect(pkg.synthesis?.method).toBe("extractive");
      expect(pkg.provenance.queries).toHaveLength(2);
      expect(
        permissions.checks.some((c) => c.capability === "research" && c.action === "deep"),
      ).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("research e2e #2: conflicting sources surface one conflict", () => {
  it("keeps both sources and records the disagreement", async () => {
    const { server, port } = await startServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (req.url === "/a") {
        res.end(
          "<html><body><main><p>The service has 100M users worldwide.</p></main></body></html>",
        );
        return;
      }
      res.end("<html><body><main><p>Reports put the base at 80M users.</p></main></body></html>");
    });
    try {
      const searchBackend: SearchProvider = {
        provider: "test-search",
        async search() {
          return [
            {
              title: "Source A",
              url: `http://127.0.0.1:${port}/a`,
              snippet: "100M users",
              domain: "127.0.0.1",
            },
            {
              title: "Source B",
              url: `http://127.0.0.1:${port}/b`,
              snippet: "80M users",
              domain: "127.0.0.1",
            },
          ];
        },
      };
      const router = new ResearchRouter();
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

      const outcome = await executor.execute(
        "builtin:research.deep",
        { queries: ["service user count"], depth: "shallow" },
        { projectId: "e2e", toolCallId: createToolCallId() },
      );
      expect(outcome.isError).toBe(false);
      const pkg = JSON.parse(String(outcome.result)) as ResearchPackage;
      expect(pkg.conflicts).toHaveLength(1);
      // Neither source silently discarded.
      expect(pkg.sources).toHaveLength(2);
      expect(pkg.conflicts[0]?.claimA.sourceIds).toHaveLength(1);
      expect(pkg.conflicts[0]?.claimB.sourceIds).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});

describe("research e2e #3: static failure -> browser fallback -> evidence + citation", () => {
  it("recovers JS-only content through the PR34 boundary", async () => {
    const { server, port } = await startServer((req, res) => {
      if (req.url === "/app") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<html><body><div id=root></div><script>render()</script></body></html>");
        return;
      }
      res.statusCode = 404;
      res.end("nope");
    });
    try {
      const appUrl = `http://127.0.0.1:${port}/app`;
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
      const searchBackend: SearchProvider = {
        provider: "test-search",
        async search() {
          return [{ title: "JS App", url: appUrl, snippet: "app", domain: "127.0.0.1" }];
        },
      };
      const router = new ResearchRouter();
      router.register(emptyAdapter);
      router.register(new SearchAdapter({ provider: searchBackend }));
      const service = new ResearchService({
        router,
        browserService: stubBrowserService(
          "JS-rendered article body with substantive findings for evidence extraction.",
        ) as never,
      });
      const permissions = new AllowAllPermissions();
      const executor = new ResearchToolExecutor({
        permissionManager: permissions,
        researchService: service,
      });

      const outcome = await executor.execute(
        "builtin:research.deep",
        { queries: ["js app findings"], depth: "shallow" },
        { projectId: "e2e", toolCallId: createToolCallId() },
      );
      expect(outcome.isError).toBe(false);
      const pkg = JSON.parse(String(outcome.result)) as ResearchPackage;
      expect(pkg.provenance.providersAttempted).toContain("browser-fallback");
      expect(pkg.evidence.length).toBeGreaterThan(0);
      expect(pkg.citations).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
