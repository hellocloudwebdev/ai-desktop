// PR34.3: apps/desktop — Browser Session and Page Lifecycle Manager
//
// Invariants:
//   1. Mediates all engine page operations through per-page promise queues for strict sequential consistency.
//   2. Enforces resource limits: MAX_SESSIONS (10), MAX_PAGES_PER_SESSION (20), MAX_ACTION_DURATION_MS (60s).
//   3. Navigations and element references are strictly validated via BrowserNavigationPolicy and BrowserRefRegistry.
//   4. Truncates snapshot elements to MAX_SNAPSHOT_ELEMENTS (200) and snapshot bytes to MAX_SNAPSHOT_BYTES (64KB).

import {
  type BrowserContextId,
  type BrowserElementInfo,
  type BrowserElementRef,
  type BrowserPage,
  type BrowserPageId,
  type BrowserSession,
  type BrowserSessionId,
  type BrowserSnapshot,
  createBrowserContextId,
  createBrowserPageId,
  createBrowserSessionId,
  MAX_ACTION_DURATION_MS,
  MAX_PAGE_TITLE_LENGTH,
  MAX_PAGES_PER_SESSION,
  MAX_SESSIONS,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_ELEMENTS,
  MAX_TEXT_LENGTH,
} from "@ai-desktop/ai-core";
import { now } from "@ai-desktop/shared";
import {
  BrowserPageNotFound,
  BrowserResourceLimit,
  BrowserSessionNotFound,
  BrowserTimeout,
  toCanonicalBrowserError,
} from "./browser-errors.js";
import { BrowserNavigationPolicy } from "./browser-policy.js";
import { BrowserRefRegistry } from "./browser-ref-registry.js";
import type {
  BrowserEngineAdapter,
  EngineBrowser,
  EngineContext,
  EnginePage,
  EngineWaitOptions,
} from "./browser-types.js";

export interface BrowserManager {
  createSession(options: {
    projectId: string;
    mode?: "isolated" | "attached";
  }): Promise<BrowserSession>;
  closeSession(sessionId: BrowserSessionId): Promise<void>;
  getSession(sessionId: BrowserSessionId): BrowserSession | undefined;
  listSessions(projectId?: string): BrowserSession[];

  openPage(
    sessionId: BrowserSessionId,
    options?: { url?: string; name?: string },
  ): Promise<BrowserPage>;
  closePage(pageId: BrowserPageId): Promise<void>;
  listPages(sessionId?: BrowserSessionId): BrowserPage[];
  getPage(pageId: BrowserPageId): BrowserPage | undefined;
  getSessionForPage(pageId: BrowserPageId): BrowserSession | undefined;

  navigate(pageId: BrowserPageId, url: string, signal?: AbortSignal): Promise<BrowserPage>;
  snapshot(pageId: BrowserPageId): Promise<BrowserSnapshot>;
  click(pageId: BrowserPageId, ref: BrowserElementRef, signal?: AbortSignal): Promise<void>;
  fill(
    pageId: BrowserPageId,
    ref: BrowserElementRef,
    value: string,
    signal?: AbortSignal,
  ): Promise<void>;
  select(
    pageId: BrowserPageId,
    ref: BrowserElementRef,
    values: readonly string[],
    signal?: AbortSignal,
  ): Promise<void>;
  press(pageId: BrowserPageId, key: string, signal?: AbortSignal): Promise<void>;
  wait(
    pageId: BrowserPageId,
    options: {
      condition: "navigation" | "selector" | "timeout";
      target?: string;
      timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  screenshot(
    pageId: BrowserPageId,
    options?: { fullPage?: boolean },
    signal?: AbortSignal,
  ): Promise<Buffer>;
  close(): Promise<void>;
}

interface SessionRecord {
  session: BrowserSession;
  context: EngineContext;
  contextId: BrowserContextId;
  pageIds: Set<BrowserPageId>;
}

interface PageRecord {
  page: BrowserPage;
  enginePage: EnginePage;
  sessionId: BrowserSessionId;
}

export interface BrowserManagerDeps {
  readonly engineAdapter: BrowserEngineAdapter;
  readonly navigationPolicy?: BrowserNavigationPolicy;
  readonly refRegistry?: BrowserRefRegistry;
}

export class DefaultBrowserManager implements BrowserManager {
  private readonly _engineAdapter: BrowserEngineAdapter;
  private readonly _policy: BrowserNavigationPolicy;
  private readonly _refRegistry: BrowserRefRegistry;

  private _engineBrowser?: EngineBrowser;
  private readonly _sessions = new Map<BrowserSessionId, SessionRecord>();
  private readonly _pages = new Map<BrowserPageId, PageRecord>();
  private readonly _pageQueues = new Map<BrowserPageId, Promise<void>>();

  constructor(deps: BrowserManagerDeps) {
    this._engineAdapter = deps.engineAdapter;
    this._policy = deps.navigationPolicy ?? new BrowserNavigationPolicy();
    this._refRegistry = deps.refRegistry ?? new BrowserRefRegistry();
  }

  private async _ensureBrowser(): Promise<EngineBrowser> {
    if (!this._engineBrowser || !this._engineBrowser.isConnected()) {
      this._engineBrowser = await this._engineAdapter.launch();
    }
    return this._engineBrowser;
  }

  private async _enqueueForPage<T>(pageId: BrowserPageId, task: () => Promise<T>): Promise<T> {
    const currentQueue = this._pageQueues.get(pageId) ?? Promise.resolve();
    let resolveQueue!: () => void;
    const nextInQueue = new Promise<void>((resolve) => {
      resolveQueue = resolve;
    });

    const queuePromise = currentQueue.then(
      () => nextInQueue,
      () => nextInQueue,
    );
    this._pageQueues.set(pageId, queuePromise);

    await currentQueue;
    try {
      return await this._withTimeout(task(), MAX_ACTION_DURATION_MS);
    } finally {
      resolveQueue();
      if (this._pageQueues.get(pageId) === queuePromise) {
        this._pageQueues.delete(pageId);
      }
    }
  }

  private async _withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new BrowserTimeout(`Action timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async createSession(options: {
    projectId: string;
    mode?: "isolated" | "attached";
  }): Promise<BrowserSession> {
    const activeSessions = [...this._sessions.values()].filter(
      (s) => s.session.status !== "closed",
    );
    if (activeSessions.length >= MAX_SESSIONS) {
      throw new BrowserResourceLimit(
        `Maximum number of browser sessions (${MAX_SESSIONS}) exceeded`,
      );
    }

    try {
      const browser = await this._ensureBrowser();
      const context = await browser.createContext();
      const sessionId = createBrowserSessionId();
      const contextId = createBrowserContextId();

      const session: BrowserSession = {
        id: sessionId,
        projectId: options.projectId,
        mode: options.mode ?? "isolated",
        status: "ready",
        createdAt: now(),
      };

      this._sessions.set(sessionId, {
        session,
        context,
        contextId,
        pageIds: new Set(),
      });

      return session;
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }

  async closeSession(sessionId: BrowserSessionId): Promise<void> {
    const record = this._sessions.get(sessionId);
    if (!record) {
      throw new BrowserSessionNotFound(sessionId);
    }

    try {
      // Close all pages in session
      for (const pageId of [...record.pageIds]) {
        await this.closePage(pageId).catch(() => {});
      }

      await record.context.close().catch(() => {});
      record.session.status = "closed";
      record.session.updatedAt = now();
      this._sessions.delete(sessionId);
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }

  getSession(sessionId: BrowserSessionId): BrowserSession | undefined {
    return this._sessions.get(sessionId)?.session;
  }

  listSessions(projectId?: string): BrowserSession[] {
    const sessions: BrowserSession[] = [];
    for (const record of this._sessions.values()) {
      if (!projectId || record.session.projectId === projectId) {
        sessions.push(record.session);
      }
    }
    return sessions;
  }

  async openPage(
    sessionId: BrowserSessionId,
    options?: { url?: string; name?: string },
  ): Promise<BrowserPage> {
    const sessionRecord = this._sessions.get(sessionId);
    if (!sessionRecord || sessionRecord.session.status === "closed") {
      throw new BrowserSessionNotFound(sessionId);
    }

    if (sessionRecord.pageIds.size >= MAX_PAGES_PER_SESSION) {
      throw new BrowserResourceLimit(
        `Maximum pages per session (${MAX_PAGES_PER_SESSION}) exceeded`,
      );
    }

    const targetUrl = options?.url?.trim() || "about:blank";
    this._policy.assertAllowed(targetUrl);

    try {
      const enginePage = await sessionRecord.context.newPage();
      const pageId = createBrowserPageId();

      if (targetUrl !== "about:blank") {
        await enginePage.goto(targetUrl, { timeoutMs: MAX_ACTION_DURATION_MS });
      }

      const initialTitle = await enginePage.title().catch(() => "");
      const page: BrowserPage = {
        id: pageId,
        contextId: sessionRecord.contextId,
        name: options?.name,
        url: enginePage.url() || targetUrl,
        title: initialTitle ? initialTitle.slice(0, MAX_PAGE_TITLE_LENGTH) : "",
        status: "ready",
        createdAt: now(),
      };

      this._pages.set(pageId, {
        page,
        enginePage,
        sessionId,
      });
      sessionRecord.pageIds.add(pageId);

      return page;
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }

  async closePage(pageId: BrowserPageId): Promise<void> {
    const pageRecord = this._pages.get(pageId);
    if (!pageRecord) {
      throw new BrowserPageNotFound(pageId);
    }

    try {
      this._refRegistry.invalidateForPage(pageId);
      await pageRecord.enginePage.close().catch(() => {});
      pageRecord.page.status = "closed";
      pageRecord.page.updatedAt = now();

      const sessionRecord = this._sessions.get(pageRecord.sessionId);
      if (sessionRecord) {
        sessionRecord.pageIds.delete(pageId);
      }
      this._pages.delete(pageId);
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }

  listPages(sessionId?: BrowserSessionId): BrowserPage[] {
    const pages: BrowserPage[] = [];
    for (const record of this._pages.values()) {
      if (!sessionId || record.sessionId === sessionId) {
        pages.push(record.page);
      }
    }
    return pages;
  }

  getPage(pageId: BrowserPageId): BrowserPage | undefined {
    return this._pages.get(pageId)?.page;
  }

  getSessionForPage(pageId: BrowserPageId): BrowserSession | undefined {
    const pageRecord = this._pages.get(pageId);
    if (!pageRecord) {
      return undefined;
    }
    return this._sessions.get(pageRecord.sessionId)?.session;
  }

  async navigate(pageId: BrowserPageId, url: string, signal?: AbortSignal): Promise<BrowserPage> {
    const pageRecord = this._pages.get(pageId);
    if (!pageRecord || pageRecord.page.status === "closed") {
      throw new BrowserPageNotFound(pageId);
    }

    this._policy.assertAllowed(url);

    return this._enqueueForPage(pageId, async () => {
      this._refRegistry.invalidateForPage(pageId);
      pageRecord.page.status = "loading";
      pageRecord.page.updatedAt = now();

      try {
        await pageRecord.enginePage.goto(url, { signal, timeoutMs: MAX_ACTION_DURATION_MS });
        const title = await pageRecord.enginePage.title().catch(() => "");

        pageRecord.page.url = pageRecord.enginePage.url() || url;
        pageRecord.page.title = title ? title.slice(0, MAX_PAGE_TITLE_LENGTH) : "";
        pageRecord.page.status = "ready";
        pageRecord.page.updatedAt = now();

        return pageRecord.page;
      } catch (err: unknown) {
        pageRecord.page.status = "error";
        pageRecord.page.updatedAt = now();
        throw toCanonicalBrowserError(err);
      }
    });
  }

  async snapshot(pageId: BrowserPageId): Promise<BrowserSnapshot> {
    const pageRecord = this._pages.get(pageId);
    if (!pageRecord || pageRecord.page.status === "closed") {
      throw new BrowserPageNotFound(pageId);
    }

    return this._enqueueForPage(pageId, async () => {
      try {
        const raw = await pageRecord.enginePage.snapshot();
        this._refRegistry.invalidateForPage(pageId);

        const elements: BrowserElementInfo[] = [];
        let truncated = false;
        let estimatedBytes = 0;

        for (const el of raw.elements) {
          if (elements.length >= MAX_SNAPSHOT_ELEMENTS) {
            truncated = true;
            break;
          }

          const ref = this._refRegistry.assignRef(pageId, el.selector, el.role, el.name);
          const elementInfo: BrowserElementInfo = {
            ref,
            role: el.role,
            name: el.name,
            text: el.text,
            value: el.value,
            disabled: el.disabled,
            checked: el.checked,
            selector: el.selector,
          };

          const entryBytes = JSON.stringify(elementInfo).length;
          if (estimatedBytes + entryBytes > MAX_SNAPSHOT_BYTES) {
            truncated = true;
            break;
          }

          estimatedBytes += entryBytes;
          elements.push(elementInfo);
        }

        const text = raw.text ? raw.text.slice(0, MAX_TEXT_LENGTH) : "";
        const title = raw.title ? raw.title.slice(0, MAX_PAGE_TITLE_LENGTH) : pageRecord.page.title;

        pageRecord.page.url = raw.url || pageRecord.page.url;
        pageRecord.page.title = title;
        pageRecord.page.updatedAt = now();

        return {
          pageId,
          url: pageRecord.page.url,
          title,
          text,
          elements,
          truncated,
          timestamp: now(),
        };
      } catch (err: unknown) {
        throw toCanonicalBrowserError(err);
      }
    });
  }

  async click(pageId: BrowserPageId, ref: BrowserElementRef, signal?: AbortSignal): Promise<void> {
    const pageRecord = this._pages.get(pageId);
    if (!pageRecord || pageRecord.page.status === "closed") {
      throw new BrowserPageNotFound(pageId);
    }

    const entry = this._refRegistry.resolve(pageId, ref);

    return this._enqueueForPage(pageId, async () => {
      try {
        await pageRecord.enginePage.click(entry.selector, { signal });
      } catch (err: unknown) {
        throw toCanonicalBrowserError(err);
      }
    });
  }

  async fill(
    pageId: BrowserPageId,
    ref: BrowserElementRef,
    value: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const pageRecord = this._pages.get(pageId);
    if (!pageRecord || pageRecord.page.status === "closed") {
      throw new BrowserPageNotFound(pageId);
    }

    const entry = this._refRegistry.resolve(pageId, ref);

    return this._enqueueForPage(pageId, async () => {
      try {
        await pageRecord.enginePage.fill(entry.selector, value, { signal });
      } catch (err: unknown) {
        throw toCanonicalBrowserError(err);
      }
    });
  }

  async select(
    pageId: BrowserPageId,
    ref: BrowserElementRef,
    values: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const pageRecord = this._pages.get(pageId);
    if (!pageRecord || pageRecord.page.status === "closed") {
      throw new BrowserPageNotFound(pageId);
    }

    const entry = this._refRegistry.resolve(pageId, ref);

    return this._enqueueForPage(pageId, async () => {
      try {
        await pageRecord.enginePage.select(entry.selector, values, { signal });
      } catch (err: unknown) {
        throw toCanonicalBrowserError(err);
      }
    });
  }

  async press(pageId: BrowserPageId, key: string, signal?: AbortSignal): Promise<void> {
    const pageRecord = this._pages.get(pageId);
    if (!pageRecord || pageRecord.page.status === "closed") {
      throw new BrowserPageNotFound(pageId);
    }

    return this._enqueueForPage(pageId, async () => {
      try {
        await pageRecord.enginePage.press(key, { signal });
      } catch (err: unknown) {
        throw toCanonicalBrowserError(err);
      }
    });
  }

  async wait(
    pageId: BrowserPageId,
    options: EngineWaitOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    const pageRecord = this._pages.get(pageId);
    if (!pageRecord || pageRecord.page.status === "closed") {
      throw new BrowserPageNotFound(pageId);
    }

    return this._enqueueForPage(pageId, async () => {
      try {
        await pageRecord.enginePage.wait(options, signal);
      } catch (err: unknown) {
        throw toCanonicalBrowserError(err);
      }
    });
  }

  async screenshot(
    pageId: BrowserPageId,
    options?: { fullPage?: boolean },
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const pageRecord = this._pages.get(pageId);
    if (!pageRecord || pageRecord.page.status === "closed") {
      throw new BrowserPageNotFound(pageId);
    }

    if (signal?.aborted) {
      throw toCanonicalBrowserError(new Error("Screenshot aborted"));
    }

    return this._enqueueForPage(pageId, async () => {
      try {
        return await pageRecord.enginePage.screenshot(options);
      } catch (err: unknown) {
        throw toCanonicalBrowserError(err);
      }
    });
  }

  async close(): Promise<void> {
    try {
      for (const sessionId of [...this._sessions.keys()]) {
        await this.closeSession(sessionId).catch(() => {});
      }
      this._sessions.clear();
      this._pages.clear();
      this._pageQueues.clear();
      this._refRegistry.clear();

      if (this._engineBrowser) {
        await this._engineBrowser.close().catch(() => {});
        this._engineBrowser = undefined;
      }
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }
}
