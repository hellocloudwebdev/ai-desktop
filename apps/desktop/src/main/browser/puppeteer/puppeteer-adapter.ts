// PR34.3: apps/desktop — Puppeteer Engine Adapter
//
// Invariants:
//   1. Strictly encapsulates puppeteer-core inside this module; zero Puppeteer types leak outside.
//   2. Implements engine-neutral interfaces (BrowserEngineAdapter, EngineBrowser, EngineContext, EnginePage).
//   3. snapshot() inspects interactive elements and accessibility names/roles via DOM evaluation,
//      without exposing user to arbitrary script execution, and redacts sensitive/password fields.
//   4. screenshot() returns raw PNG Buffers.
//   5. Maps all runtime and driver errors via toCanonicalBrowserError.

import fs from "node:fs";
import path from "node:path";
import puppeteer, {
  type Browser as PuppeteerBrowserInstance,
  type BrowserContext as PuppeteerContextInstance,
  type Page as PuppeteerPageInstance,
} from "puppeteer-core";
import { generateUlid } from "@ai-desktop/shared";
import {
  BrowserActionFailed,
  BrowserCancelled,
  BrowserNotFound,
  toCanonicalBrowserError,
} from "../browser-errors.js";
import type {
  BrowserEngineAdapter,
  EngineActionOptions,
  EngineBrowser,
  EngineConnectOptions,
  EngineContext,
  EngineGotoOptions,
  EngineLaunchOptions,
  EnginePage,
  EngineScreenshotOptions,
  EngineWaitOptions,
  RawSnapshotData,
} from "../browser-types.js";

/**
 * Searches well-known system paths for a Chrome or Edge executable.
 */
export function findSystemBrowserExecutable(): string | undefined {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const isLinux = process.platform === "linux";

  const candidates: string[] = [];

  if (isWindows) {
    const progFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const progFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] || "";

    candidates.push(
      path.join(progFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(progFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(progFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(progFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
    if (localAppData) {
      candidates.push(
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
      );
    }
  } else if (isMac) {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else if (isLinux) {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    );
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore inaccessible paths
    }
  }

  return undefined;
}

class PuppeteerEnginePage implements EnginePage {
  readonly id: string;
  private readonly _page: PuppeteerPageInstance;

  constructor(page: PuppeteerPageInstance) {
    this.id = generateUlid();
    this._page = page;
  }

  url(): string {
    return this._page.url();
  }

  async title(): Promise<string> {
    return this._page.title();
  }

  async goto(url: string, options?: EngineGotoOptions): Promise<void> {
    if (options?.signal?.aborted) {
      throw new BrowserCancelled("Navigation aborted");
    }

    const onAbort = () => {
      // Abort signal listener
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await this._page.goto(url, {
        timeout: options?.timeoutMs ?? 30000,
        waitUntil: "domcontentloaded",
      });
    } catch (err: unknown) {
      if (options?.signal?.aborted) {
        throw new BrowserCancelled("Navigation aborted", { cause: err });
      }
      throw toCanonicalBrowserError(err);
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  async snapshot(): Promise<RawSnapshotData> {
    try {
      const raw = await this._page.evaluate(() => {
        function getCssSelector(el: Element): string {
          if (el.id && /^[a-z0-9_-]+$/i.test(el.id)) {
            return `#${el.id}`;
          }
          const tag = el.tagName.toLowerCase();
          const parent = el.parentElement;
          if (!parent) {
            return tag;
          }
          const siblings = Array.from(parent.children).filter(
            (c) => c.tagName.toLowerCase() === tag,
          );
          if (siblings.length === 1) {
            return `${getCssSelector(parent)} > ${tag}`;
          }
          const index = siblings.indexOf(el) + 1;
          return `${getCssSelector(parent)} > ${tag}:nth-of-type(${index})`;
        }

        function getAccessibleName(el: Element): string {
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel && ariaLabel.trim()) {
            return ariaLabel.trim();
          }

          const ariaLabelledBy = el.getAttribute("aria-labelledby");
          if (ariaLabelledBy) {
            const ids = ariaLabelledBy.split(/\s+/);
            const labels: string[] = [];
            for (const id of ids) {
              const refEl = document.getElementById(id);
              if (refEl && refEl.textContent?.trim()) {
                labels.push(refEl.textContent.trim());
              }
            }
            if (labels.length > 0) {
              return labels.join(" ");
            }
          }

          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            if (el.placeholder && el.placeholder.trim()) {
              return el.placeholder.trim();
            }
            const labels = el.labels;
            if (labels && labels.length > 0) {
              const txt = Array.from(labels)
                .map((l) => l.textContent?.trim())
                .filter(Boolean)
                .join(" ");
              if (txt) {
                return txt;
              }
            }
          }

          if (el instanceof HTMLImageElement && el.alt && el.alt.trim()) {
            return el.alt.trim();
          }

          const title = el.getAttribute("title");
          if (title && title.trim()) {
            return title.trim();
          }

          const text = el.textContent?.trim();
          if (text) {
            return text.length > 100 ? text.slice(0, 100) + "..." : text;
          }

          return "";
        }

        function getRole(el: Element): string {
          const explicitRole = el.getAttribute("role");
          if (explicitRole && explicitRole.trim()) {
            return explicitRole.trim();
          }

          const tag = el.tagName.toLowerCase();
          if (tag === "a" && el.hasAttribute("href")) {
            return "link";
          }
          if (tag === "button") {
            return "button";
          }
          if (tag === "textarea") {
            return "textbox";
          }
          if (tag === "select") {
            return "combobox";
          }
          if (tag === "input") {
            const type = (el.getAttribute("type") || "text").toLowerCase();
            switch (type) {
              case "checkbox":
                return "checkbox";
              case "radio":
                return "radio";
              case "button":
              case "submit":
              case "reset":
                return "button";
              case "number":
                return "spinbutton";
              case "range":
                return "slider";
              case "password":
                return "password";
              default:
                return "textbox";
            }
          }
          return tag;
        }

        const interactiveQuery =
          "a[href], button, input, select, textarea, [role], [tabindex]:not([tabindex='-1']), [contenteditable='true']";
        const matched = Array.from(document.querySelectorAll(interactiveQuery));
        const elements: Array<{
          role: string;
          name: string;
          text?: string;
          value?: string;
          disabled?: boolean;
          checked?: boolean;
          selector: string;
        }> = [];

        for (const el of matched) {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            continue;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) {
            continue;
          }

          const role = getRole(el);
          const name = getAccessibleName(el);
          const isInput =
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLSelectElement;
          const isPassword =
            (el instanceof HTMLInputElement && el.type === "password") || role === "password";

          const value = isPassword
            ? undefined
            : isInput
              ? (el as HTMLInputElement).value
              : undefined;
          const disabled = (el as HTMLInputElement).disabled ?? undefined;
          const checked = (el as HTMLInputElement).checked ?? undefined;
          const text =
            !isInput && el.textContent?.trim() ? el.textContent.trim().slice(0, 100) : undefined;
          const selector = getCssSelector(el);

          elements.push({
            role,
            name,
            text,
            value,
            disabled,
            checked,
            selector,
          });

          if (elements.length >= 300) {
            break;
          }
        }

        const pageText = (document.body?.innerText || document.body?.textContent || "").slice(
          0,
          10000,
        );

        return {
          url: window.location.href,
          title: document.title,
          text: pageText,
          elements,
        };
      });

      return raw;
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }

  async click(selector: string, options?: EngineActionOptions): Promise<void> {
    if (options?.signal?.aborted) {
      throw new BrowserCancelled("Click aborted");
    }

    try {
      const el = await this._page.waitForSelector(selector, { timeout: 10000 });
      if (!el) {
        throw new BrowserActionFailed(`Element not found for selector "${selector}"`);
      }
      if (options?.signal?.aborted) {
        throw new BrowserCancelled("Click aborted");
      }
      await el.click();
    } catch (err: unknown) {
      if (options?.signal?.aborted) {
        throw new BrowserCancelled("Click aborted", { cause: err });
      }
      throw toCanonicalBrowserError(err);
    }
  }

  async fill(selector: string, value: string, options?: EngineActionOptions): Promise<void> {
    if (options?.signal?.aborted) {
      throw new BrowserCancelled("Fill aborted");
    }

    try {
      const el = await this._page.waitForSelector(selector, { timeout: 10000 });
      if (!el) {
        throw new BrowserActionFailed(`Element not found for selector "${selector}"`);
      }
      if (options?.signal?.aborted) {
        throw new BrowserCancelled("Fill aborted");
      }
      await el.click({ count: 3 });
      await this._page.keyboard.press("Backspace");
      await el.type(value);
    } catch (err: unknown) {
      if (options?.signal?.aborted) {
        throw new BrowserCancelled("Fill aborted", { cause: err });
      }
      throw toCanonicalBrowserError(err);
    }
  }

  async select(
    selector: string,
    values: readonly string[],
    options?: EngineActionOptions,
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw new BrowserCancelled("Select aborted");
    }

    try {
      await this._page.select(selector, ...values);
    } catch (err: unknown) {
      if (options?.signal?.aborted) {
        throw new BrowserCancelled("Select aborted", { cause: err });
      }
      throw toCanonicalBrowserError(err);
    }
  }

  async press(key: string, options?: EngineActionOptions): Promise<void> {
    if (options?.signal?.aborted) {
      throw new BrowserCancelled("Press aborted");
    }

    try {
      await (this._page.keyboard as unknown as { press: (k: string) => Promise<void> }).press(key);
    } catch (err: unknown) {
      if (options?.signal?.aborted) {
        throw new BrowserCancelled("Press aborted", { cause: err });
      }
      throw toCanonicalBrowserError(err);
    }
  }

  async wait(options: EngineWaitOptions, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new BrowserCancelled("Wait aborted");
    }

    try {
      if (options.condition === "navigation") {
        await this._page.waitForNavigation({ timeout: options.timeoutMs ?? 30000 });
      } else if (options.condition === "selector") {
        if (!options.target) {
          throw new BrowserActionFailed("Selector condition requires a target");
        }
        await this._page.waitForSelector(options.target, { timeout: options.timeoutMs ?? 30000 });
      } else if (options.condition === "timeout") {
        const ms = options.timeoutMs ?? 1000;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, ms);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new BrowserCancelled("Wait aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
    } catch (err: unknown) {
      if (signal?.aborted) {
        throw new BrowserCancelled("Wait aborted", { cause: err });
      }
      throw toCanonicalBrowserError(err);
    }
  }

  async screenshot(options?: EngineScreenshotOptions): Promise<Buffer> {
    try {
      const data = await this._page.screenshot({
        fullPage: options?.fullPage ?? false,
        type: "png",
      });
      return Buffer.from(data);
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }

  async close(): Promise<void> {
    try {
      if (!this._page.isClosed()) {
        await this._page.close();
      }
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }

  isClosed(): boolean {
    return this._page.isClosed();
  }
}

class PuppeteerEngineContext implements EngineContext {
  private readonly _context: PuppeteerContextInstance;

  constructor(context: PuppeteerContextInstance) {
    this._context = context;
  }

  async newPage(): Promise<EnginePage> {
    try {
      const page = await this._context.newPage();
      return new PuppeteerEnginePage(page);
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }

  async close(): Promise<void> {
    try {
      await this._context.close();
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }
}

class PuppeteerEngineBrowser implements EngineBrowser {
  private readonly _browser: PuppeteerBrowserInstance;

  constructor(browser: PuppeteerBrowserInstance) {
    this._browser = browser;
  }

  async createContext(_options?: { persistentPath?: string }): Promise<EngineContext> {
    void _options;
    try {
      const context = await this._browser.createBrowserContext();
      return new PuppeteerEngineContext(context);
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }

  async close(): Promise<void> {
    try {
      await this._browser.close();
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }

  isConnected(): boolean {
    return this._browser.connected;
  }
}

export class PuppeteerAdapter implements BrowserEngineAdapter {
  private readonly _executablePath?: string;

  constructor(options?: { executablePath?: string }) {
    this._executablePath = options?.executablePath;
  }

  async isAvailable(): Promise<boolean> {
    const execPath = this._executablePath ?? findSystemBrowserExecutable();
    return Boolean(execPath);
  }

  async launch(options?: EngineLaunchOptions): Promise<EngineBrowser> {
    const executablePath =
      options?.executablePath ?? this._executablePath ?? findSystemBrowserExecutable();
    if (!executablePath) {
      throw new BrowserNotFound(
        "No compatible Chrome or Edge browser executable found on the system",
      );
    }

    try {
      const browser = await puppeteer.launch({
        executablePath,
        headless: options?.headless ?? true,
        args: options?.args ? [...options.args] : ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      return new PuppeteerEngineBrowser(browser);
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }

  async connect(options: EngineConnectOptions): Promise<EngineBrowser> {
    try {
      const browser = await puppeteer.connect({
        browserWSEndpoint: options.browserWSEndpoint,
      });
      return new PuppeteerEngineBrowser(browser);
    } catch (err: unknown) {
      throw toCanonicalBrowserError(err);
    }
  }
}
