// PR47: apps/desktop — Update types suite (semver + schema boundaries).

import { describe, expect, it } from "vitest";
import {
  compareSemver,
  isNewerVersion,
  isSupportedUpgrade,
  UpdateMetadataSchema,
} from "./update-types.js";

function validMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1.2.3",
    channel: "stable",
    platform: "win32",
    arch: "x64",
    artifact: "https://github.com/acme/app/releases/download/v1.2.3/app.exe",
    sha256: "a".repeat(64),
    size: 1024,
    releaseDate: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("compareSemver", () => {
  it("orders major/minor/patch numerically", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
  });

  it("treats a release as newer than its prerelease", () => {
    expect(compareSemver("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
  });

  it("throws on invalid input (fail-closed)", () => {
    expect(() => compareSemver("not-a-version", "1.0.0")).toThrow();
  });
});

describe("isNewerVersion / isSupportedUpgrade", () => {
  it("detects strictly newer versions", () => {
    expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("0.9.9", "1.0.0")).toBe(false);
  });

  it("enforces minimum supported versions", () => {
    expect(isSupportedUpgrade("1.2.0", "1.0.0")).toBe(true);
    expect(isSupportedUpgrade("0.9.0", "1.0.0")).toBe(false);
    expect(isSupportedUpgrade("0.9.0", undefined)).toBe(true);
  });
});

describe("UpdateMetadataSchema", () => {
  it("accepts a well-formed manifest", () => {
    expect(UpdateMetadataSchema.safeParse(validMetadata()).success).toBe(true);
  });

  it("rejects http artifact URLs", () => {
    const parsed = UpdateMetadataSchema.safeParse(
      validMetadata({ artifact: "http://github.com/acme/app/app.exe" }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects malformed sha256 checksums", () => {
    const parsed = UpdateMetadataSchema.safeParse(validMetadata({ sha256: "zzzz" }));
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown channels", () => {
    const parsed = UpdateMetadataSchema.safeParse(validMetadata({ channel: "canary" }));
    expect(parsed.success).toBe(false);
  });
});
