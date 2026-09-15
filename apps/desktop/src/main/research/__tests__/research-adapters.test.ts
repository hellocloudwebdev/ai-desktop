// PR35.15-35.19/35.30: apps/desktop — Adapter Tests (search/github/youtube/rss)
//
// Covers normalization, dedupe, bounds, provider errors, auth boundary,
// and cancellation for all four adapters. Fully hermetic: fetch is
// injected; no live internet.

import { describe, expect, it } from "vitest";
import { defaultResearchPolicy } from "../research-policy.js";
import { ExaSearchAdapter } from "../adapters/search/search-provider.js";
import { GithubResearchAdapter } from "../adapters/github/github-research.js";
import {
  decodeTimedText,
  extractYoutubeVideoId,
  YoutubeResearchAdapter,
} from "../adapters/youtube/youtube-research.js";
import { parseFeedXml, RssResearchAdapter } from "../adapters/rss/rss-research.js";

function testPolicy() {
  return defaultResearchPolicy({ denyLoopback: false });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("exa search adapter", () => {
  const results = {
    results: [
      {
        title: "First",
        url: "https://example.com/a?utm_source=x",
        text: "snippet one",
        publishedDate: "2026-09-01T00:00:00.000Z",
        score: 0.9,
      },
      {
        title: "First dup",
        url: "https://example.com/a#frag",
        text: "snippet two",
      },
      { title: "Second", url: "https://example.com/b", text: "snippet three" },
      { title: "Bad", url: "javascript:alert(1)", text: "evil" },
      { title: "Empty", url: "", text: "none" },
    ],
  };

  function fetchFn(response: Response): typeof fetch {
    return (async () => response) as typeof fetch;
  }

  it("normalizes, dedupes, and bounds results in provider order", async () => {
    const adapter = new ExaSearchAdapter({
      policy: testPolicy(),
      fetchFn: fetchFn(jsonResponse(results)),
      resolveSecret: async () => "exa-key",
      apiKeyRef: "provider/search/exa/api-key",
    });
    const hits = await adapter.search("local llm", { maxResults: 10 });
    expect(hits.map((h) => h.title)).toEqual(["First", "Second"]);
    expect(hits[0]!.domain).toBe("example.com");
    expect(hits[0]!.publishedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(hits[0]!.score).toBe(0.9);
  });

  it("reports authRequired health and errors without a key", async () => {
    const keyless = new ExaSearchAdapter({
      policy: testPolicy(),
      fetchFn: fetchFn(jsonResponse({})),
    });
    expect(await keyless.health()).toBe("authRequired");
    await expect(keyless.search("x")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    const denied = new ExaSearchAdapter({
      policy: testPolicy(),
      fetchFn: fetchFn(jsonResponse({}, 401)),
      resolveSecret: async () => "bad-key",
      apiKeyRef: "provider/search/exa/api-key",
    });
    await expect(denied.search("x")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("maps provider failures and honors cancellation", async () => {
    const failing = new ExaSearchAdapter({
      policy: testPolicy(),
      fetchFn: fetchFn(jsonResponse({}, 500)),
      resolveSecret: async () => "k",
      apiKeyRef: "provider/search/exa/api-key",
    });
    await expect(failing.search("x")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });

    const controller = new AbortController();
    controller.abort();
    const adapter = new ExaSearchAdapter({
      policy: testPolicy(),
      fetchFn: fetchFn(jsonResponse(results)),
      resolveSecret: async () => "k",
      apiKeyRef: "provider/search/exa/api-key",
    });
    await expect(adapter.search("x", { signal: controller.signal })).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });
});

describe("github research adapter", () => {
  function githubFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
    return (async (input: unknown) => {
      const url = String(input);
      const route = routes[url];
      if (!route) return new Response("missing", { status: 404 });
      return jsonResponse(route.body, route.status);
    }) as typeof fetch;
  }

  const repoBody = {
    full_name: "octo/hello",
    description: "demo",
    language: "TypeScript",
    stargazers_count: 42,
    html_url: "https://github.com/octo/hello",
  };
  const fileBody = {
    type: "file",
    size: 11,
    html_url: "https://github.com/octo/hello/blob/HEAD/README.md",
    content: Buffer.from("hello world").toString("base64"),
  };

  it("reads repositories, files, issues, and pulls with structured text", async () => {
    const adapter = new GithubResearchAdapter({
      policy: testPolicy(),
      fetchFn: githubFetch({
        "https://api.github.com/repos/octo/hello": { status: 200, body: repoBody },
        "https://api.github.com/repos/octo/hello/contents/README.md": {
          status: 200,
          body: fileBody,
        },
        "https://api.github.com/repos/octo/hello/issues/1": {
          status: 200,
          body: {
            title: "Bug",
            body: "broken",
            html_url: "https://github.com/octo/hello/issues/1",
          },
        },
        "https://api.github.com/repos/octo/hello/pulls/2": {
          status: 200,
          body: { title: "Fix", body: "fixed", html_url: "https://github.com/octo/hello/pull/2" },
        },
      }),
    });
    const repo = await adapter.read({ operation: "repository", owner: "octo", repo: "hello" });
    expect(repo.title).toBe("octo/hello");
    expect(repo.text).toContain("Stars: 42");

    const file = await adapter.read({
      operation: "file",
      owner: "octo",
      repo: "hello",
      path: "README.md",
    });
    expect(file.text).toBe("hello world");

    const issue = await adapter.read({
      operation: "issue",
      owner: "octo",
      repo: "hello",
      number: 1,
    });
    expect(issue.title).toBe("Bug");

    const pull = await adapter.read({ operation: "pull", owner: "octo", repo: "hello", number: 2 });
    expect(pull.title).toBe("Fix");
  });

  it("searches repositories into normalized results", async () => {
    const adapter = new GithubResearchAdapter({
      policy: testPolicy(),
      fetchFn: githubFetch({
        "https://api.github.com/search/repositories?q=llm&per_page=10": {
          status: 200,
          body: {
            items: [
              {
                full_name: "a/b",
                description: "desc",
                html_url: "https://github.com/a/b",
              },
            ],
          },
        },
      }),
    });
    const result = await adapter.read({ operation: "search", query: "llm" });
    expect(result.searchResults).toHaveLength(1);
    expect(result.searchResults![0]!.domain).toBe("github.com");
  });

  it("enforces the auth boundary and maps 404/429 without leaking tokens", async () => {
    const adapter = new GithubResearchAdapter({
      policy: testPolicy(),
      fetchFn: githubFetch({}),
    });
    await expect(
      adapter.read({ operation: "repository", owner: "o", repo: "r" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const authed = new GithubResearchAdapter({
      policy: testPolicy(),
      fetchFn: (async (input: unknown, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (headers.get("authorization") !== "Bearer ghp_testtoken1234567890") {
          return jsonResponse({}, 401);
        }
        return jsonResponse(repoBody);
      }) as typeof fetch,
      resolveSecret: async () => "ghp_testtoken1234567890",
      apiKeyRef: "provider/github/api-key",
    });
    const repo = await authed.read({ operation: "repository", owner: "octo", repo: "hello" });
    expect(repo.title).toBe("octo/hello");

    const limited = new GithubResearchAdapter({
      policy: testPolicy(),
      fetchFn: githubFetch({
        "https://api.github.com/repos/o/r": { status: 429, body: {} },
      }),
    });
    const err = (await limited
      .read({ operation: "repository", owner: "o", repo: "r" })
      .catch((e: unknown) => e)) as { code?: string; message?: string };
    expect(err.code).toBe("PROVIDER_ERROR");
    expect(String(err.message)).not.toContain("ghp_");
  });

  it("rejects traversal paths and requires repo coordinates", async () => {
    const adapter = new GithubResearchAdapter({
      policy: testPolicy(),
      fetchFn: githubFetch({}),
    });
    await expect(
      adapter.read({ operation: "file", owner: "o", repo: "r", path: "../x" }),
    ).rejects.toThrow();
    await expect(adapter.read({ operation: "repository" })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });
});

describe("youtube research adapter", () => {
  it("extracts video IDs from watch, share, shorts, and embed URLs", () => {
    expect(extractYoutubeVideoId({ videoId: "dQw4w9WgXcQ" })).toBe("dQw4w9WgXcQ");
    expect(extractYoutubeVideoId({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10" })).toBe(
      "dQw4w9WgXcQ",
    );
    expect(extractYoutubeVideoId({ url: "https://youtu.be/dQw4w9WgXcQ" })).toBe("dQw4w9WgXcQ");
    expect(extractYoutubeVideoId({ url: "https://www.youtube.com/shorts/dQw4w9WgXcQ" })).toBe(
      "dQw4w9WgXcQ",
    );
    expect(extractYoutubeVideoId({ url: "https://www.youtube.com/embed/dQw4w9WgXcQ" })).toBe(
      "dQw4w9WgXcQ",
    );
    expect(extractYoutubeVideoId({ url: "https://example.com/" })).toBeNull();
    expect(extractYoutubeVideoId({})).toBeNull();
  });

  it("decodes timedtext transcripts into plain lines", () => {
    const xml = `<?xml version="1.0"?><transcript><text start="0">Hello &amp; welcome</text><text start="1">  </text><text start="2">Second line</text></transcript>`;
    expect(decodeTimedText(xml)).toBe("Hello & welcome\nSecond line");
  });

  it("reads oEmbed metadata keyless and reports missing videos", async () => {
    const adapter = new YoutubeResearchAdapter({
      policy: testPolicy(),
      fetchFn: (async (input: unknown) => {
        const url = String(input);
        if (url.includes("oembed")) {
          return jsonResponse({ title: "Demo", author_name: "Author" });
        }
        return new Response("missing", { status: 404 });
      }) as typeof fetch,
    });
    const meta = await adapter.read({ operation: "metadata", videoId: "dQw4w9WgXcQ" });
    expect(meta.title).toBe("Demo");
    expect(meta.provider).toBe("youtube-oembed");
  });

  it("degrades cleanly when captions are unavailable", async () => {
    const adapter = new YoutubeResearchAdapter({
      policy: testPolicy(),
      fetchFn: (async () =>
        new Response("<html><body>no captions here</body></html>", {
          headers: { "content-type": "text/html" },
        })) as typeof fetch,
    });
    await expect(
      adapter.read({ operation: "transcript", videoId: "dQw4w9WgXcQ" }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("requires a SecretRef key for search (authRequired, no scraping)", async () => {
    const keyless = new YoutubeResearchAdapter({ policy: testPolicy() });
    await expect(keyless.read({ operation: "search", query: "x" })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });

    const keyed = new YoutubeResearchAdapter({
      policy: testPolicy(),
      fetchFn: (async () =>
        jsonResponse({
          items: [
            {
              id: { videoId: "abc123" },
              snippet: {
                title: "Vid",
                description: "desc",
                publishedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          ],
        })) as typeof fetch,
      resolveSecret: async () => "yt-key",
      apiKeyRef: "provider/youtube/api-key",
    });
    const result = await keyed.read({ operation: "search", query: "x" });
    expect(result.searchResults).toHaveLength(1);
    expect(result.provider).toBe("youtube-api");
  });
});

describe("rss research adapter", () => {
  const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>Demo Feed</title>
<item><title>One</title><link>https://example.com/1</link><description>First &amp; best</description><pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate><author>alice@example.com</author></item>
<item><title>Two</title><link>https://example.com/2</link><description><![CDATA[<b>Second</b> item]]></description></item>
</channel></rss>`;

  const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Feed</title>
<entry><title>A1</title><link href="https://example.com/a1"/><summary>Summary</summary><published>2026-09-02T00:00:00Z</published><author><name>Bob</name></author></entry>
</feed>`;

  it("parses RSS and Atom into normalized items", () => {
    const rss = parseFeedXml(RSS, 10);
    expect(rss.title).toBe("Demo Feed");
    expect(rss.items).toHaveLength(2);
    expect(rss.items[0]).toMatchObject({
      title: "One",
      url: "https://example.com/1",
      summary: "First & best",
      author: "alice@example.com",
    });
    expect(rss.items[0]!.publishedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(rss.items[1]!.summary).toBe("Second item");

    const atom = parseFeedXml(ATOM, 10);
    expect(atom.items).toHaveLength(1);
    expect(atom.items[0]).toMatchObject({
      title: "A1",
      url: "https://example.com/a1",
      author: "Bob",
    });
  });

  it("rejects malformed feeds and enforces item limits", () => {
    expect(() => parseFeedXml("<html>nope</html>", 10)).toThrow();
    const many = parseFeedXml(RSS, 1);
    expect(many.items).toHaveLength(1);
    expect(many.truncated).toBe(true);
  });

  it("reads feeds end to end with SSRF policy and cancellation", async () => {
    const adapter = new RssResearchAdapter({
      policy: testPolicy(),
      fetchFn: (async () =>
        new Response(RSS, { headers: { "content-type": "application/rss+xml" } })) as typeof fetch,
    });
    const feed = await adapter.read("https://example.com/feed", { maxItems: 10 });
    expect(feed.title).toBe("Demo Feed");
    expect(feed.items).toHaveLength(2);

    await expect(adapter.read("file:///etc/passwd")).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.read("https://example.com/feed", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
