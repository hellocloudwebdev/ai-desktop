// PR36: apps/desktop — Source Canonicalizer Tests

import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-desktop/shared";
import {
  canonicalizeSourceUrl,
  groupSourcesByCanonicalUrl,
  sameSourceUrl,
} from "../source-canonicalizer.js";

describe("canonicalizeSourceUrl", () => {
  it("strips utm_* tracking params", () => {
    expect(canonicalizeSourceUrl("https://example.com/article?utm_source=x&utm_medium=y")).toBe(
      "https://example.com/article",
    );
  });

  it("strips gclid/fbclid/msclkid", () => {
    expect(canonicalizeSourceUrl("https://example.com/a?gclid=1&fbclid=2&msclkid=3")).toBe(
      "https://example.com/a",
    );
  });

  it("strips mc_* and wbraid/gbraid/igshid/_ga/yclid/twclid", () => {
    expect(
      canonicalizeSourceUrl(
        "https://example.com/a?mc_cid=1&wbraid=2&igshid=3&_ga=4&yclid=5&twclid=6",
      ),
    ).toBe("https://example.com/a");
  });

  it("keeps meaningful query params", () => {
    expect(canonicalizeSourceUrl("https://example.com/search?q=agents&page=2")).toBe(
      "https://example.com/search?page=2&q=agents",
    );
  });

  it("sorts remaining query params deterministically", () => {
    expect(canonicalizeSourceUrl("https://example.com/s?z=1&a=2")).toBe(
      "https://example.com/s?a=2&z=1",
    );
  });

  it("strips fragments", () => {
    expect(canonicalizeSourceUrl("https://example.com/article#section")).toBe(
      "https://example.com/article",
    );
  });

  it("strips default ports", () => {
    expect(canonicalizeSourceUrl("https://example.com:443/a")).toBe("https://example.com/a");
    expect(canonicalizeSourceUrl("http://example.com:80/a")).toBe("http://example.com/a");
  });

  it("keeps non-default ports", () => {
    expect(canonicalizeSourceUrl("http://example.com:8080/a")).toBe("http://example.com:8080/a");
  });

  it("lowercases scheme and host but not path", () => {
    expect(canonicalizeSourceUrl("HTTPS://EXAMPLE.COM/Path")).toBe("https://example.com/Path");
  });

  it("collapses trailing slash on paths and root", () => {
    expect(canonicalizeSourceUrl("https://example.com/article/")).toBe(
      "https://example.com/article",
    );
    expect(canonicalizeSourceUrl("https://example.com/")).toBe("https://example.com");
  });

  it("treats utm variant with fragment as the same source", () => {
    expect(
      sameSourceUrl("https://example.com/article", "https://example.com/article?utm_source=x#s"),
    ).toBe(true);
  });

  it("keeps distinct paths distinct", () => {
    expect(sameSourceUrl("https://example.com/a", "https://example.com/b")).toBe(false);
  });

  it("keeps distinct hosts distinct", () => {
    expect(sameSourceUrl("https://a.example.com/x", "https://b.example.com/x")).toBe(false);
  });

  it("throws ValidationError on invalid input", () => {
    expect(() => canonicalizeSourceUrl("")).toThrow(ValidationError);
    expect(() => canonicalizeSourceUrl("not a url")).toThrow(ValidationError);
    expect(() => canonicalizeSourceUrl("javascript:alert(1)")).toThrow(ValidationError);
  });

  it("sameSourceUrl never throws", () => {
    expect(sameSourceUrl("garbage", "also garbage")).toBe(false);
    expect(sameSourceUrl("https://example.com/a", "garbage")).toBe(false);
  });
});

describe("groupSourcesByCanonicalUrl", () => {
  it("merges cross-provider duplicates with unioned providers", () => {
    const groups = groupSourcesByCanonicalUrl([
      { url: "https://example.com/article", title: "Article", provider: "google" },
      { url: "https://example.com/article?utm_source=x", provider: "exa" },
      { url: "https://example.com/article#section", provider: "bing" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.providers).toEqual(["google", "exa", "bing"]);
    expect(groups[0]?.rawUrls).toHaveLength(3);
    expect(groups[0]?.title).toBe("Article");
  });

  it("keeps unrelated URLs separate", () => {
    const groups = groupSourcesByCanonicalUrl([
      { url: "https://example.com/a", provider: "google" },
      { url: "https://example.com/b", provider: "exa" },
    ]);
    expect(groups).toHaveLength(2);
  });

  it("skips invalid URLs", () => {
    const groups = groupSourcesByCanonicalUrl([
      { url: "garbage", provider: "google" },
      { url: "https://example.com/a", provider: "exa" },
    ]);
    expect(groups).toHaveLength(1);
  });

  it("dedupes repeated provider entries", () => {
    const groups = groupSourcesByCanonicalUrl([
      { url: "https://example.com/a", provider: "google" },
      { url: "https://example.com/a?gclid=1", provider: "google" },
    ]);
    expect(groups[0]?.providers).toEqual(["google"]);
  });

  it("handles empty input", () => {
    expect(groupSourcesByCanonicalUrl([])).toEqual([]);
  });
});
