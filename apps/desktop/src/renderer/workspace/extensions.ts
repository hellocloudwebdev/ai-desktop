// PR32: renderer — Extension IPC Bridge
//
// Narrow structural access to the PR32 extension commands exposed on
// window.api by the preload (owned by another agent). This module never
// redefines the preload contract: it probes for the exact command names,
// treats every result as unknown, and normalizes accepted shapes into
// ExtensionView records. Absent commands (preload not yet updated, or tests
// without window) yield null and the surface renders an empty state.

import type { ExtensionView } from "../components/workspace/surfaces/surface-props.js";

export type ExtensionLifecycle = ExtensionView["lifecycle"];

const EXTENSION_LIFECYCLES: readonly string[] = ["installed", "enabled", "active", "disabled"];

/** Structural shape of the PR32 extension commands. Results stay unknown. */
export interface ExtensionCommands {
  listExtensions(args: { projectId?: string }): Promise<unknown>;
  getExtension(args: { extensionId: string }): Promise<unknown>;
  installExtension(args: { sourceDir: string; projectId?: string }): Promise<unknown>;
  uninstallExtension(args: { extensionId: string }): Promise<unknown>;
  enableExtension(args: { extensionId: string }): Promise<unknown>;
  disableExtension(args: { extensionId: string }): Promise<unknown>;
  setExtensionProjectEnabled(args: {
    extensionId: string;
    projectId: string;
    enabled: boolean;
  }): Promise<unknown>;
}

const EXTENSION_COMMAND_NAMES = [
  "listExtensions",
  "getExtension",
  "installExtension",
  "uninstallExtension",
  "enableExtension",
  "disableExtension",
  "setExtensionProjectEnabled",
] as const;

/**
 * Returns the PR32 extension commands when the preload exposes all of them,
 * otherwise null. Never throws: missing window/api/commands is an expected
 * state, not an error.
 */
export function getExtensionCommands(): ExtensionCommands | null {
  try {
    if (typeof window === "undefined") return null;
    const api = window.api as
      { commands?: Record<string, ((args: never) => Promise<unknown>) | unknown> } | undefined;
    const commands = api?.commands;
    if (!commands) return null;
    for (const name of EXTENSION_COMMAND_NAMES) {
      if (typeof commands[name] !== "function") return null;
    }
    return commands as unknown as ExtensionCommands;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Accepts either the raw ExtensionInfo[] payload or the standard IPC
 * envelope ({ ok: true, value: { extensions } } / { ok: true, value: [...] })
 * and returns the candidate list. Anything else yields [].
 */
export function unwrapExtensionList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  if (raw.ok === true) {
    if (Array.isArray(raw.value)) return raw.value;
    if (isRecord(raw.value) && Array.isArray(raw.value.extensions)) {
      return raw.value.extensions;
    }
    return [];
  }
  if (Array.isArray(raw.extensions)) return raw.extensions;
  return [];
}

/** Validates one unknown entry into an ExtensionView, or null when unusable. */
export function normalizeExtensionInfo(item: unknown): ExtensionView | null {
  if (!isRecord(item)) return null;
  if (typeof item.id !== "string" || item.id.length === 0) return null;
  if (typeof item.name !== "string" || item.name.length === 0) return null;
  if (typeof item.version !== "string") return null;
  if (typeof item.lifecycle !== "string" || !EXTENSION_LIFECYCLES.includes(item.lifecycle)) {
    return null;
  }
  return {
    id: item.id,
    name: item.name,
    version: item.version,
    displayName: asOptionalString(item.displayName),
    description: asOptionalString(item.description),
    capabilities: asStringArray(item.capabilities),
    lifecycle: item.lifecycle as ExtensionLifecycle,
    trust: typeof item.trust === "string" ? item.trust : "unknown",
    manifestHash: typeof item.manifestHash === "string" ? item.manifestHash : "",
    installedAt: typeof item.installedAt === "string" ? item.installedAt : "",
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
    enabledProjects: asStringArray(item.enabledProjects),
  };
}

/** Normalizes a candidate list, dropping entries that fail validation. */
export function normalizeExtensionInfos(items: readonly unknown[]): ExtensionView[] {
  const views: ExtensionView[] = [];
  for (const item of items) {
    const view = normalizeExtensionInfo(item);
    if (view) views.push(view);
  }
  return views;
}

/** Lists extensions through the bridge and normalizes the result. */
export async function fetchExtensionList(
  commands: ExtensionCommands,
  projectId?: string,
): Promise<ExtensionView[]> {
  const raw = await commands.listExtensions(projectId ? { projectId } : {});
  return normalizeExtensionInfos(unwrapExtensionList(raw));
}
