import { describe, expect, it } from "vitest";
import { isUlid } from "@ai-desktop/shared";
import {
  createBrowserSessionId,
  createBrowserContextId,
  createBrowserPageId,
  createBrowserActionId,
  parseBrowserSessionId,
  parseBrowserContextId,
  parseBrowserPageId,
  parseBrowserActionId,
  parseBrowserElementRef,
  asBrowserSessionId,
  asBrowserContextId,
  asBrowserPageId,
  asBrowserActionId,
  asBrowserElementRef,
  BrowserSessionIdSchema,
  BrowserContextIdSchema,
  BrowserPageIdSchema,
  BrowserActionIdSchema,
  BrowserElementRefSchema,
} from "./identifiers.js";
import {
  BROWSER_TOOL_IDS,
  BrowserSessionModeSchema,
  BrowserSessionStatusSchema,
  BrowserSessionSchema,
  BrowserPersistenceModeSchema,
  BrowserContextSchema,
  BrowserPageStatusSchema,
  BrowserPageSchema,
  BrowserElementInfoSchema,
  BrowserSnapshotSchema,
  BrowserActionTypeSchema,
  BrowserOpenInputSchema,
  BrowserNavigateInputSchema,
  BrowserPagesInputSchema,
  BrowserSnapshotInputSchema,
  BrowserClickInputSchema,
  BrowserFillInputSchema,
  BrowserSelectInputSchema,
  BrowserPressInputSchema,
  BrowserWaitInputSchema,
  BrowserScreenshotInputSchema,
  BrowserCloseInputSchema,
  buildBrowserToolDefinition,
  buildAllBrowserToolDefinitions,
  isBrowserToolId,
  isSafeBrowserUrl,
  isSensitiveField,
  redactSensitiveValue,
  browserRiskFor,
  DANGEROUS_BROWSER_URL_PATTERN,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_ELEMENTS,
  MAX_PAGE_TITLE_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_SESSIONS,
  MAX_PAGES_PER_SESSION,
  MAX_ACTION_DURATION_MS,
  SENSITIVE_FIELD_PATTERN,
} from "./browser.js";
import { ToolDefinitionSchema } from "./tools.js";

describe("Browser Subsystem - Identifiers", () => {
  it("creates valid branded ULIDs for session, context, page, and action", () => {
    const sessionId = createBrowserSessionId();
    const contextId = createBrowserContextId();
    const pageId = createBrowserPageId();
    const actionId = createBrowserActionId();

    expect(isUlid(sessionId)).toBe(true);
    expect(isUlid(contextId)).toBe(true);
    expect(isUlid(pageId)).toBe(true);
    expect(isUlid(actionId)).toBe(true);
  });

  it("parses valid ULIDs and rejects invalid ULIDs", () => {
    const valid = createBrowserSessionId();
    const lower = valid.toLowerCase();

    expect(parseBrowserSessionId(lower)).toBe(valid);
    expect(parseBrowserContextId(lower)).toBe(valid);
    expect(parseBrowserPageId(lower)).toBe(valid);
    expect(parseBrowserActionId(lower)).toBe(valid);

    expect(BrowserSessionIdSchema.safeParse(valid).success).toBe(true);
    expect(BrowserContextIdSchema.safeParse(valid).success).toBe(true);
    expect(BrowserPageIdSchema.safeParse(valid).success).toBe(true);
    expect(BrowserActionIdSchema.safeParse(valid).success).toBe(true);

    expect(BrowserSessionIdSchema.safeParse("bad").success).toBe(false);
    expect(BrowserContextIdSchema.safeParse("bad").success).toBe(false);
    expect(BrowserPageIdSchema.safeParse("bad").success).toBe(false);
    expect(BrowserActionIdSchema.safeParse("bad").success).toBe(false);

    expect(() => parseBrowserSessionId("invalid-id")).toThrow(TypeError);
    expect(() => parseBrowserContextId("invalid-id")).toThrow(TypeError);
    expect(() => parseBrowserPageId("invalid-id")).toThrow(TypeError);
    expect(() => parseBrowserActionId("invalid-id")).toThrow(TypeError);
  });

  it("validates BrowserElementRef patterns", () => {
    expect(BrowserElementRefSchema.safeParse("ref/e1").success).toBe(true);
    expect(BrowserElementRefSchema.safeParse("ref/btn-submit").success).toBe(true);
    expect(BrowserElementRefSchema.safeParse("e12").success).toBe(true);
    expect(BrowserElementRefSchema.safeParse("button_1").success).toBe(true);

    expect(BrowserElementRefSchema.safeParse("").success).toBe(false);
    expect(BrowserElementRefSchema.safeParse("ref/e1/extra").success).toBe(false);
    expect(BrowserElementRefSchema.safeParse("has spaces").success).toBe(false);
    expect(BrowserElementRefSchema.safeParse("<script>").success).toBe(false);

    expect(parseBrowserElementRef("ref/e5")).toBe("ref/e5");
    expect(() => parseBrowserElementRef("bad@ref")).toThrow();
  });

  it("supports asBrowser* cast helpers", () => {
    const raw = "test-raw";
    expect(asBrowserSessionId(raw)).toBe(raw);
    expect(asBrowserContextId(raw)).toBe(raw);
    expect(asBrowserPageId(raw)).toBe(raw);
    expect(asBrowserActionId(raw)).toBe(raw);
    expect(asBrowserElementRef(raw)).toBe(raw);
  });
});

describe("Browser Subsystem - Domain Schemas", () => {
  it("validates enum schemas for session, persistence, page, and actions", () => {
    expect(BrowserSessionModeSchema.options).toEqual(["isolated", "attached"]);
    expect(BrowserSessionStatusSchema.options).toEqual([
      "starting",
      "ready",
      "closing",
      "closed",
      "failed",
    ]);
    expect(BrowserPersistenceModeSchema.options).toEqual(["ephemeral", "persistent"]);
    expect(BrowserPageStatusSchema.options).toEqual(["loading", "ready", "closed", "error"]);
    expect(BrowserActionTypeSchema.options).toEqual([
      "open",
      "navigate",
      "pages",
      "snapshot",
      "click",
      "fill",
      "select",
      "press",
      "wait",
      "screenshot",
      "close",
    ]);
  });

  it("validates BrowserSessionSchema with default isolated mode", () => {
    const sessionId = createBrowserSessionId();
    const session = BrowserSessionSchema.parse({
      id: sessionId,
      projectId: "proj-1",
      status: "ready",
      createdAt: "2026-09-13T10:00:00.000Z",
    });

    expect(session.id).toBe(sessionId);
    expect(session.mode).toBe("isolated");
    expect(session.status).toBe("ready");
  });

  it("validates BrowserContextSchema with default ephemeral mode", () => {
    const contextId = createBrowserContextId();
    const sessionId = createBrowserSessionId();
    const context = BrowserContextSchema.parse({
      id: contextId,
      sessionId,
      createdAt: "2026-09-13T10:00:00.000Z",
    });

    expect(context.id).toBe(contextId);
    expect(context.persistenceMode).toBe("ephemeral");
  });

  it("validates BrowserPageSchema with default ready status and empty title", () => {
    const pageId = createBrowserPageId();
    const contextId = createBrowserContextId();
    const page = BrowserPageSchema.parse({
      id: pageId,
      contextId,
      url: "https://example.com",
      createdAt: "2026-09-13T10:00:00.000Z",
    });

    expect(page.id).toBe(pageId);
    expect(page.title).toBe("");
    expect(page.status).toBe("ready");
  });

  it("validates BrowserElementInfoSchema and BrowserSnapshotSchema", () => {
    const pageId = createBrowserPageId();
    const element1 = BrowserElementInfoSchema.parse({
      ref: "ref/e1",
      role: "button",
      name: "Submit",
      disabled: false,
    });
    const element2 = BrowserElementInfoSchema.parse({
      ref: "e2",
      role: "textbox",
      name: "Email",
      value: "test@example.com",
    });

    const snapshot = BrowserSnapshotSchema.parse({
      pageId,
      url: "https://example.com",
      title: "Example Domain",
      text: "Example Domain text content",
      elements: [element1, element2],
      timestamp: "2026-09-13T10:00:00.000Z",
    });

    expect(snapshot.elements).toHaveLength(2);
    expect(snapshot.truncated).toBe(false);
  });
});

describe("Browser Subsystem - Tool Definitions and Actions", () => {
  it("defines all 11 canonical browser tool IDs", () => {
    expect(BROWSER_TOOL_IDS).toHaveLength(11);
    for (const toolId of BROWSER_TOOL_IDS) {
      expect(isBrowserToolId(toolId)).toBe(true);
    }
    expect(isBrowserToolId("builtin:browser.unknown")).toBe(false);
  });

  it("builds canonical ToolDefinition adhering to ToolDefinitionSchema", () => {
    const allDefs = buildAllBrowserToolDefinitions();
    expect(allDefs).toHaveLength(11);

    for (const def of allDefs) {
      expect(ToolDefinitionSchema.safeParse(def).success).toBe(true);
      expect(def.source).toBe("builtin");
      expect(def.runtime).toBe("browser");
      expect(def.requiredPermissions).toEqual(["browser"]);
      expect(def.parameters.type).toBe("object");
      expect(def.description.length).toBeGreaterThan(5);

      const singleDef = buildBrowserToolDefinition(def.name as (typeof BROWSER_TOOL_IDS)[number]);
      expect(singleDef).toEqual(def);
    }
  });

  it("validates inputs for all browser action schemas", () => {
    const pageId = createBrowserPageId();
    const sessionId = createBrowserSessionId();

    expect(BrowserOpenInputSchema.safeParse({ url: "https://example.com" }).success).toBe(true);
    expect(
      BrowserNavigateInputSchema.safeParse({ pageId, url: "https://example.com" }).success,
    ).toBe(true);
    expect(BrowserPagesInputSchema.safeParse({}).success).toBe(true);
    expect(BrowserPagesInputSchema.safeParse({ sessionId }).success).toBe(true);
    expect(BrowserSnapshotInputSchema.safeParse({ pageId }).success).toBe(true);
    expect(BrowserClickInputSchema.safeParse({ pageId, ref: "ref/e1" }).success).toBe(true);
    expect(BrowserFillInputSchema.safeParse({ pageId, ref: "ref/e1", value: "test" }).success).toBe(
      true,
    );
    expect(
      BrowserSelectInputSchema.safeParse({ pageId, ref: "ref/e1", values: ["opt1"] }).success,
    ).toBe(true);
    expect(BrowserPressInputSchema.safeParse({ pageId, key: "Enter" }).success).toBe(true);
    expect(
      BrowserWaitInputSchema.safeParse({ pageId, condition: "navigation", timeoutMs: 5000 })
        .success,
    ).toBe(true);
    expect(BrowserScreenshotInputSchema.safeParse({ pageId, fullPage: true }).success).toBe(true);
    expect(BrowserCloseInputSchema.safeParse({ pageId }).success).toBe(true);

    // Rejection on invalid inputs
    expect(BrowserOpenInputSchema.safeParse({ url: "" }).success).toBe(false);
    expect(
      BrowserNavigateInputSchema.safeParse({ pageId: "not-ulid", url: "https://test.com" }).success,
    ).toBe(false);
    expect(BrowserClickInputSchema.safeParse({ pageId, ref: "invalid ref!" }).success).toBe(false);
    expect(BrowserWaitInputSchema.safeParse({ pageId, condition: "invalid-cond" }).success).toBe(
      false,
    );
    expect(
      BrowserWaitInputSchema.safeParse({ pageId, condition: "timeout", timeoutMs: 70000 }).success,
    ).toBe(false);
  });
});

describe("Browser Subsystem - URL Safety and Security", () => {
  it("allows safe http, https, and about:blank URLs", () => {
    expect(isSafeBrowserUrl("https://example.com")).toBe(true);
    expect(isSafeBrowserUrl("http://localhost:3000")).toBe(true);
    expect(isSafeBrowserUrl("http://127.0.0.1:8080/path?q=1")).toBe(true);
    expect(isSafeBrowserUrl("about:blank")).toBe(true);
  });

  it("rejects dangerous URL schemes and malformed URLs", () => {
    expect(isSafeBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeBrowserUrl("  JaVaScRiPt:alert(1)")).toBe(false);
    expect(isSafeBrowserUrl("data:text/html,<h1>hi</h1>")).toBe(false);
    expect(isSafeBrowserUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeBrowserUrl("blob:https://example.com/uuid")).toBe(false);
    expect(isSafeBrowserUrl("vbscript:msgbox")).toBe(false);
    expect(isSafeBrowserUrl("ftp://ftp.example.com")).toBe(false);
    expect(isSafeBrowserUrl("")).toBe(false);
    expect(isSafeBrowserUrl("   ")).toBe(false);
    expect(isSafeBrowserUrl("not-a-url")).toBe(false);
  });

  it("matches dangerous URL regex correctly", () => {
    expect(DANGEROUS_BROWSER_URL_PATTERN.test("javascript:void(0)")).toBe(true);
    expect(DANGEROUS_BROWSER_URL_PATTERN.test("DATA:text/plain")).toBe(true);
    expect(DANGEROUS_BROWSER_URL_PATTERN.test("file:///C:/test")).toBe(true);
    expect(DANGEROUS_BROWSER_URL_PATTERN.test("blob:http://localhost")).toBe(true);
  });
});

describe("Browser Subsystem - Redaction and Sensitivity", () => {
  it("identifies sensitive field names", () => {
    expect(isSensitiveField("password")).toBe(true);
    expect(isSensitiveField("userPassword")).toBe(true);
    expect(isSensitiveField("current_passcode")).toBe(true);
    expect(isSensitiveField("api_key")).toBe(true);
    expect(isSensitiveField("apiKey")).toBe(true);
    expect(isSensitiveField("api-key")).toBe(true);
    expect(isSensitiveField("authToken")).toBe(true);
    expect(isSensitiveField("client_secret")).toBe(true);
    expect(isSensitiveField("credit_card")).toBe(true);
    expect(isSensitiveField("creditcard_number")).toBe(true);

    expect(isSensitiveField("username")).toBe(false);
    expect(isSensitiveField("email")).toBe(false);
    expect(isSensitiveField("searchQuery")).toBe(false);
  });

  it("redacts sensitive values properly", () => {
    expect(redactSensitiveValue("mySecret123")).toBe("[REDACTED]");
    expect(redactSensitiveValue("")).toBe("");
  });
});

describe("Browser Subsystem - Risk Assessment", () => {
  it("maps browser actions to correct risk levels", () => {
    expect(browserRiskFor("snapshot")).toBe("low");
    expect(browserRiskFor("pages")).toBe("low");

    expect(browserRiskFor("open")).toBe("medium");
    expect(browserRiskFor("navigate")).toBe("medium");
    expect(browserRiskFor("click")).toBe("medium");
    expect(browserRiskFor("select")).toBe("medium");
    expect(browserRiskFor("press")).toBe("medium");
    expect(browserRiskFor("wait")).toBe("medium");
    expect(browserRiskFor("screenshot")).toBe("medium");
    expect(browserRiskFor("close")).toBe("medium");

    expect(browserRiskFor("fill")).toBe("medium");
    expect(browserRiskFor("fill", "username")).toBe("medium");
    expect(browserRiskFor("fill", "password")).toBe("high");
    expect(browserRiskFor("fill", "apiKey")).toBe("high");
    expect(browserRiskFor("fill", "credit_card")).toBe("high");
  });
});

describe("Browser Subsystem - Constants & Limits", () => {
  it("exports required limit constants", () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(64 * 1024);
    expect(MAX_SNAPSHOT_ELEMENTS).toBe(200);
    expect(MAX_PAGE_TITLE_LENGTH).toBe(200);
    expect(MAX_TEXT_LENGTH).toBe(10000);
    expect(MAX_SESSIONS).toBe(10);
    expect(MAX_PAGES_PER_SESSION).toBe(20);
    expect(MAX_ACTION_DURATION_MS).toBe(60000);
    expect(SENSITIVE_FIELD_PATTERN).toBeInstanceOf(RegExp);
  });
});
