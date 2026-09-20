// apps/desktop — Release app identity tests.

import { describe, expect, it } from "vitest";
import { APP_IDENTITY, getAppDataDirName } from "./app-identity.js";

describe("release: app identity", () => {
  it("pins every identity field to its stable value", () => {
    expect(APP_IDENTITY.appId).toBe("com.aidesktop.app");
    expect(APP_IDENTITY.productName).toBe("AI Desktop");
    expect(APP_IDENTITY.executableName).toBe("aidesktop");
    expect(APP_IDENTITY.bundleId).toBe("com.aidesktop.app");
    expect(APP_IDENTITY.protocol).toBe("aidesktop");
    expect(APP_IDENTITY.channel).toBe("stable");
  });

  it("exposes a non-empty protocol scheme usable for deep links", () => {
    expect(APP_IDENTITY.protocol.trim().length).toBeGreaterThan(0);
    expect(APP_IDENTITY.protocol).toMatch(/^[a-z][a-z0-9+.-]*$/);
  });

  it("derives the app data directory name from the product name", () => {
    expect(getAppDataDirName()).toBe("AI Desktop");
    expect(getAppDataDirName().trim().length).toBeGreaterThan(0);
  });

  it("keeps mac bundle id aligned with the app id", () => {
    expect(APP_IDENTITY.bundleId).toBe(APP_IDENTITY.appId);
  });
});
