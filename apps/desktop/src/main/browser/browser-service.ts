// PR34.3/34.4: apps/desktop — Project-Isolated Browser Service
//
// Invariants:
//   1. Enforces project-level isolation: each project gets its own active browser session by default.
//   2. Mediates all browser actions through BrowserManager.
//   3. Manages screenshot artifacts: writes screenshots to temporary disk storage and returns
//      artifact references ({ artifactRef, bytes }) to keep tool call outputs lightweight and bounded.
//   4. Clean resource disposal on close().

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  BrowserActionType,
  BrowserClickInput,
  BrowserCloseInput,
  BrowserFillInput,
  BrowserNavigateInput,
  BrowserOpenInput,
  BrowserPagesInput,
  BrowserPressInput,
  BrowserScreenshotInput,
  BrowserSelectInput,
  BrowserSession,
  BrowserSessionId,
  BrowserSnapshotInput,
  BrowserWaitInput,
  BrowserPageId,
} from "@ai-desktop/ai-core";
import type { ToolCallId } from "@ai-desktop/shared";
import {
  BrowserActionFailed,
  BrowserPageNotFound,
  toCanonicalBrowserError,
} from "./browser-errors.js";
import type { BrowserManager } from "./browser-manager.js";

export interface ScreenshotArtifact {
  readonly artifactRef: string;
  readonly bytes: number;
}

export interface BrowserServiceDeps {
  readonly browserManager: BrowserManager;
  readonly screenshotsDir?: string;
}

export interface BrowserExecutionContext {
  readonly projectId: string;
  readonly toolCallId: ToolCallId;
  readonly signal?: AbortSignal;
}

export class BrowserService {
  private readonly _manager: BrowserManager;
  private readonly _screenshotsDir: string;
  private readonly _projectSessions = new Map<string, BrowserSessionId>();

  constructor(deps: BrowserServiceDeps) {
    this._manager = deps.browserManager;
    this._screenshotsDir = deps.screenshotsDir ?? path.join(os.tmpdir(), "ai-desktop-screenshots");
  }

  get manager(): BrowserManager {
    return this._manager;
  }

  async getOrCreateSession(projectId: string): Promise<BrowserSession> {
    const existingId = this._projectSessions.get(projectId);
    if (existingId) {
      const session = this._manager.getSession(existingId);
      if (session && session.status !== "closed" && session.status !== "failed") {
        return session;
      }
    }

    const newSession = await this._manager.createSession({
      projectId,
      mode: "isolated",
    });
    this._projectSessions.set(projectId, newSession.id);
    return newSession;
  }

  private _assertPageInProject(pageId: BrowserPageId, projectId: string): void {
    if (typeof this._manager.getSessionForPage === "function") {
      const session = this._manager.getSessionForPage(pageId);
      if (session && session.projectId !== projectId) {
        throw new BrowserPageNotFound(
          pageId,
          `Browser page "${pageId}" does not belong to project "${projectId}"`,
        );
      }
    }
  }

  async executeAction(
    action: BrowserActionType,
    input: unknown,
    context: BrowserExecutionContext,
  ): Promise<unknown> {
    try {
      switch (action) {
        case "open": {
          const openInput = input as BrowserOpenInput;
          const session = await this.getOrCreateSession(context.projectId);
          return await this._manager.openPage(session.id, {
            url: openInput.url,
            name: openInput.name,
          });
        }

        case "navigate": {
          const navInput = input as BrowserNavigateInput;
          this._assertPageInProject(navInput.pageId, context.projectId);
          return await this._manager.navigate(navInput.pageId, navInput.url, context.signal);
        }

        case "pages": {
          const pagesInput = (input ?? {}) as BrowserPagesInput;
          if (pagesInput.sessionId) {
            const session = this._manager.getSession(pagesInput.sessionId);
            if (!session || session.projectId !== context.projectId) {
              return [];
            }
            return this._manager.listPages(pagesInput.sessionId);
          }
          const sessions = this._manager.listSessions(context.projectId);
          if (sessions.length === 0) {
            return [];
          }
          return sessions.flatMap((s) => this._manager.listPages(s.id));
        }

        case "snapshot": {
          const snapInput = input as BrowserSnapshotInput;
          this._assertPageInProject(snapInput.pageId, context.projectId);
          return await this._manager.snapshot(snapInput.pageId);
        }

        case "click": {
          const clickInput = input as BrowserClickInput;
          this._assertPageInProject(clickInput.pageId, context.projectId);
          await this._manager.click(clickInput.pageId, clickInput.ref, context.signal);
          return { success: true };
        }

        case "fill": {
          const fillInput = input as BrowserFillInput;
          this._assertPageInProject(fillInput.pageId, context.projectId);
          await this._manager.fill(
            fillInput.pageId,
            fillInput.ref,
            fillInput.value,
            context.signal,
          );
          return { success: true };
        }

        case "select": {
          const selectInput = input as BrowserSelectInput;
          this._assertPageInProject(selectInput.pageId, context.projectId);
          await this._manager.select(
            selectInput.pageId,
            selectInput.ref,
            selectInput.values,
            context.signal,
          );
          return { success: true };
        }

        case "press": {
          const pressInput = input as BrowserPressInput;
          this._assertPageInProject(pressInput.pageId, context.projectId);
          await this._manager.press(pressInput.pageId, pressInput.key, context.signal);
          return { success: true };
        }

        case "wait": {
          const waitInput = input as BrowserWaitInput;
          this._assertPageInProject(waitInput.pageId, context.projectId);
          await this._manager.wait(
            waitInput.pageId,
            {
              condition: waitInput.condition,
              target: waitInput.target,
              timeoutMs: waitInput.timeoutMs,
            },
            context.signal,
          );
          return { success: true };
        }

        case "screenshot": {
          const screenshotInput = input as BrowserScreenshotInput;
          this._assertPageInProject(screenshotInput.pageId, context.projectId);
          const buffer = await this._manager.screenshot(
            screenshotInput.pageId,
            { fullPage: screenshotInput.fullPage },
            context.signal,
          );
          return await this._saveScreenshotArtifact(buffer, context.toolCallId);
        }

        case "close": {
          const closeInput = input as BrowserCloseInput;
          this._assertPageInProject(closeInput.pageId, context.projectId);
          await this._manager.closePage(closeInput.pageId);
          return { success: true };
        }

        default:
          throw new BrowserActionFailed(`Unsupported browser action: "${String(action)}"`);
      }
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }

  private async _saveScreenshotArtifact(
    buffer: Buffer,
    toolCallId: ToolCallId,
  ): Promise<ScreenshotArtifact> {
    await fs.promises.mkdir(this._screenshotsDir, { recursive: true });
    const fileName = `screenshot-${toolCallId}-${Date.now()}.png`;
    const filePath = path.join(this._screenshotsDir, fileName);
    await fs.promises.writeFile(filePath, buffer);
    return {
      artifactRef: filePath,
      bytes: buffer.length,
    };
  }

  async close(): Promise<void> {
    this._projectSessions.clear();
    await this._manager.close();
  }
}
