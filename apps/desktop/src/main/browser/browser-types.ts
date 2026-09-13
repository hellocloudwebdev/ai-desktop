// PR34.3: apps/desktop — Engine-Neutral Browser Interfaces
//
// Invariants:
//   1. Pure engine-neutral interfaces for test mocking and engine decoupling.
//   2. Zero Puppeteer, Playwright, or Electron imports.

export interface EngineLaunchOptions {
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly args?: readonly string[];
}

export interface EngineConnectOptions {
  readonly browserWSEndpoint: string;
}

export interface RawSnapshotElement {
  readonly role: string;
  readonly name: string;
  readonly text?: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly selector: string;
}

export interface RawSnapshotData {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly elements: readonly RawSnapshotElement[];
}

export interface EngineGotoOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface EngineActionOptions {
  readonly signal?: AbortSignal;
}

export interface EngineWaitOptions {
  readonly condition: "navigation" | "selector" | "timeout";
  readonly target?: string;
  readonly timeoutMs?: number;
}

export interface EngineScreenshotOptions {
  readonly fullPage?: boolean;
}

export interface EnginePage {
  readonly id: string;
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: EngineGotoOptions): Promise<void>;
  snapshot(): Promise<RawSnapshotData>;
  click(selector: string, options?: EngineActionOptions): Promise<void>;
  fill(selector: string, value: string, options?: EngineActionOptions): Promise<void>;
  select(selector: string, values: readonly string[], options?: EngineActionOptions): Promise<void>;
  press(key: string, options?: EngineActionOptions): Promise<void>;
  wait(options: EngineWaitOptions, signal?: AbortSignal): Promise<void>;
  screenshot(options?: EngineScreenshotOptions): Promise<Buffer>;
  close(): Promise<void>;
  isClosed(): boolean;
}

export interface EngineContext {
  newPage(): Promise<EnginePage>;
  close(): Promise<void>;
}

export interface EngineBrowser {
  createContext(options?: { persistentPath?: string }): Promise<EngineContext>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export interface BrowserEngineAdapter {
  launch(options?: EngineLaunchOptions): Promise<EngineBrowser>;
  connect(options: EngineConnectOptions): Promise<EngineBrowser>;
  isAvailable(): Promise<boolean>;
}
