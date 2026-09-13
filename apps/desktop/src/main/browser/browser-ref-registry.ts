// PR34.3: apps/desktop — Browser Element Reference Registry
//
// Invariants:
//   1. Maps semantic element references ("ref/e1", "ref/e2") to unique CSS selectors and metadata per page.
//   2. References are invalidated on page navigation or close to prevent stale element access.
//   3. Resolving an unknown or invalidated reference throws BrowserStaleReference.

import {
  asBrowserElementRef,
  type BrowserElementRef,
  type BrowserPageId,
} from "@ai-desktop/ai-core";
import { BrowserStaleReference } from "./browser-errors.js";

export interface ElementRefEntry {
  readonly ref: BrowserElementRef;
  readonly selector: string;
  readonly role?: string;
  readonly name?: string;
  readonly handleId?: string;
}

export class BrowserRefRegistry {
  private readonly _registry = new Map<BrowserPageId, Map<BrowserElementRef, ElementRefEntry>>();
  private readonly _pageCounters = new Map<BrowserPageId, number>();

  assignRef(
    pageId: BrowserPageId,
    selector: string,
    role?: string,
    name?: string,
    handleId?: string,
  ): BrowserElementRef {
    const nextCount = (this._pageCounters.get(pageId) ?? 0) + 1;
    this._pageCounters.set(pageId, nextCount);

    const ref = asBrowserElementRef(`ref/e${nextCount}`);
    const entry: ElementRefEntry = {
      ref,
      selector,
      role,
      name,
      handleId,
    };

    let pageMap = this._registry.get(pageId);
    if (!pageMap) {
      pageMap = new Map();
      this._registry.set(pageId, pageMap);
    }
    pageMap.set(ref, entry);

    return ref;
  }

  resolve(pageId: BrowserPageId, ref: BrowserElementRef): ElementRefEntry {
    const pageMap = this._registry.get(pageId);
    const entry = pageMap?.get(ref);
    if (!entry) {
      throw new BrowserStaleReference(
        ref,
        `Stale or missing element reference "${ref}" for page "${pageId}"`,
      );
    }
    return entry;
  }

  invalidateForPage(pageId: BrowserPageId): void {
    this._registry.delete(pageId);
    this._pageCounters.delete(pageId);
  }

  getEntriesForPage(pageId: BrowserPageId): readonly ElementRefEntry[] {
    const pageMap = this._registry.get(pageId);
    if (!pageMap) {
      return [];
    }
    return [...pageMap.values()];
  }

  clear(): void {
    this._registry.clear();
    this._pageCounters.clear();
  }
}
