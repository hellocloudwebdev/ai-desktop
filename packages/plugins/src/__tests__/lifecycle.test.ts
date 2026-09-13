import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-desktop/shared";
import {
  canTransition,
  assertTransition,
  transitionLifecycle,
  initialLifecycle,
  type ExtensionLifecycle,
} from "../core/lifecycle.js";

const STATES: ExtensionLifecycle[] = ["installed", "enabled", "active", "disabled", "uninstalled"];

const LEGAL: Array<[ExtensionLifecycle, ExtensionLifecycle]> = [
  ["installed", "installed"],
  ["installed", "enabled"],
  ["disabled", "enabled"],
  ["enabled", "active"],
  ["enabled", "disabled"],
  ["active", "disabled"],
  ["installed", "uninstalled"],
  ["enabled", "uninstalled"],
  ["active", "uninstalled"],
  ["disabled", "uninstalled"],
  ["uninstalled", "uninstalled"],
];

describe("packages/plugins: lifecycle (PR32)", () => {
  it("entry state is installed", () => {
    expect(initialLifecycle()).toBe("installed");
  });

  it("allows all legal transitions", () => {
    for (const [from, to] of LEGAL) {
      expect(canTransition(from, to), `${from}->${to}`).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  it("rejects all illegal transitions", () => {
    const legalSet = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    for (const from of STATES) {
      for (const to of STATES) {
        if (legalSet.has(`${from}->${to}`)) continue;
        expect(canTransition(from, to), `${from}->${to}`).toBe(false);
        expect(() => assertTransition(from, to)).toThrow(ValidationError);
      }
    }
  });

  it("specifically rejects installed->active, active->enabled, disabled->active, uninstalled->enabled", () => {
    expect(canTransition("installed", "active")).toBe(false);
    expect(canTransition("active", "enabled")).toBe(false);
    expect(canTransition("disabled", "active")).toBe(false);
    expect(canTransition("uninstalled", "enabled")).toBe(false);
    expect(canTransition("enabled", "installed")).toBe(false);
  });

  it("transitionLifecycle is idempotent on same-state", () => {
    for (const s of STATES) {
      const res = transitionLifecycle(s, s);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toBe(s);
    }
  });

  it("transitionLifecycle returns ok for legal, err for illegal", () => {
    const okRes = transitionLifecycle("installed", "enabled");
    expect(okRes.ok).toBe(true);
    const errRes = transitionLifecycle("installed", "active");
    expect(errRes.ok).toBe(false);
    if (!errRes.ok) expect(errRes.error).toBeInstanceOf(ValidationError);
  });
});
