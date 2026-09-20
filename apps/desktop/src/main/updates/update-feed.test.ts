// PR47: apps/desktop — Update feed suite (URL allowlist + manifest parsing).

import { describe, expect, it } from "vitest";
import { buildFeedUrl, parseUpdateManifest, validateFeedUrl } from "./update-feed.js";

const REPO = "hellocloudwebdev/ai-desktop";

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1.2.3",
    channel: "stable",
    platform: "win32",
    arch: "x64",
    artifact: "https://github.com/acme/app/releases/download/v1.2.3/app.exe",
    sha256: "b".repeat(64),
    size: 2048,
    releaseDate: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildFeedUrl", () => {
  it("builds a stable feed URL", () => {
    const url = buildFeedUrl({ repo: REPO, channel: "stable", platform: "win32", arch: "x64" });
    expect(url).toBe(`https://github.com/${REPO}/releases/latest/download/update-win32-x64.json`);
  });

  it("rejects beta feeds without allowPreview", () => {
    expect(() =>
      buildFeedUrl({ repo: REPO, channel: "beta", platform: "darwin", arch: "arm64" }),
    ).toThrow();
  });

  it("builds beta feeds with explicit opt-in", () => {
    const url = buildFeedUrl({
      repo: REPO,
      channel: "beta",
      platform: "darwin",
      arch: "arm64",
      allowPreview: true,
    });
    expect(url).toContain("/releases/download/beta/");
  });
});

describe("validateFeedUrl", () => {
  it("accepts an allowlisted https feed", () => {
    expect(() =>
      validateFeedUrl(`https://github.com/${REPO}/releases/latest/download/update-win32-x64.json`),
    ).not.toThrow();
  });

  it("rejects http feeds", () => {
    expect(() => validateFeedUrl("http://github.com/acme/app/feed.json")).toThrow();
  });

  it("rejects unknown hosts", () => {
    expect(() => validateFeedUrl("https://evil.example.com/feed.json")).toThrow();
  });
});

describe("parseUpdateManifest", () => {
  it("parses a valid manifest", () => {
    expect(parseUpdateManifest(validManifest(), "stable").version).toBe("1.2.3");
  });

  it("rejects malformed manifests", () => {
    expect(() => parseUpdateManifest({ version: "nope" }, "stable")).toThrow();
  });

  it("rejects channel mismatches", () => {
    expect(() => parseUpdateManifest(validManifest({ channel: "beta" }), "stable")).toThrow();
  });
});
