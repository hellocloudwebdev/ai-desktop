// PR35: apps/desktop — GitHub Research Adapter
//
// Structured public GitHub research over the api.github.com REST API:
// repository metadata, file contents (base64-decoded, bounded), issue
// lookup, and repository search. Authenticated access resolves a token
// host-side via SecretRef; public reads work without credentials.
// Never shells out to `gh`; never interpolates model input into commands.

import type { ResearchChannel } from "@ai-desktop/ai-core";
import { MAX_SEARCH_RESULTS } from "@ai-desktop/ai-core";
import { ResearchCancelled, ResearchProviderFailed } from "../../research-errors.js";
import type { ResearchPolicy } from "../../research-policy.js";
import { DEFAULT_RESEARCH_POLICY } from "../../research-policy.js";
import { secureFetch } from "../../security/secure-fetch.js";
import type { DnsResolver } from "../../security/ssrf-guard.js";
import type {
  AdapterContext,
  GithubArgs,
  GithubOutput,
  GithubResearchItem,
  ResearchAdapter,
} from "../adapter.js";

export const GITHUB_API_PROVIDER = "github-api";

export interface GithubAdapterDeps {
  readonly policy?: ResearchPolicy;
  readonly resolver?: DnsResolver;
  readonly resolveToken?: () => Promise<string | null>;
  readonly apiBase?: string;
}

function boundLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) {
    return 10;
  }
  return Math.min(Math.floor(limit), MAX_SEARCH_RESULTS);
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function excerpt(text: string, max = 1000): string {
  return text.length > max ? text.slice(0, max) : text;
}

export class GithubResearchAdapter implements ResearchAdapter {
  readonly provider = GITHUB_API_PROVIDER;
  readonly channel: ResearchChannel = "github";
  private readonly _policy: ResearchPolicy;
  private readonly _resolver?: DnsResolver;
  private readonly _resolveToken?: () => Promise<string | null>;
  private readonly _apiBase: string;

  constructor(deps: GithubAdapterDeps = {}) {
    this._policy = deps.policy ?? DEFAULT_RESEARCH_POLICY;
    this._resolver = deps.resolver;
    this._resolveToken = deps.resolveToken;
    this._apiBase = (deps.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  }

  private async _getJson(path: string, ctx: AdapterContext): Promise<unknown> {
    if (ctx.signal?.aborted) {
      throw new ResearchCancelled();
    }
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
    };
    if (this._resolveToken) {
      const token = await this._resolveToken();
      if (token) {
        headers["authorization"] = `Bearer ${token}`;
      }
    }
    const fetched = await secureFetch(`${this._apiBase}${path}`, {
      policy: this._policy,
      ...(this._resolver ? { resolver: this._resolver } : {}),
      ...(this._policy.allowedHosts
        ? { allowlist: { allowedHosts: this._policy.allowedHosts } }
        : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      headers,
    });
    try {
      return JSON.parse(fetched.body.toString("utf-8"));
    } catch {
      throw new ResearchProviderFailed(GITHUB_API_PROVIDER, "GitHub returned a non-JSON payload");
    }
  }

  async readGithub(args: GithubArgs, ctx: AdapterContext): Promise<GithubOutput> {
    const limit = boundLimit(args.limit);
    const kind = args.kind;
    if (kind === "repository" && args.owner && args.repo) {
      return { results: [await this._readRepository(args.owner, args.repo, ctx)] };
    }
    if (kind === "file" && args.owner && args.repo && args.path) {
      return { results: [await this._readFile(args.owner, args.repo, args.path, ctx)] };
    }
    if (kind === "issue" && args.owner && args.repo && args.query) {
      return { results: [await this._readIssue(args.owner, args.repo, args.query, ctx)] };
    }
    return { results: await this._search(args.query ?? "", limit, ctx) };
  }

  private async _readRepository(
    owner: string,
    repo: string,
    ctx: AdapterContext,
  ): Promise<GithubResearchItem> {
    if (!safeSegment(owner) || !safeSegment(repo)) {
      throw new ResearchProviderFailed(GITHUB_API_PROVIDER, "Invalid repository owner or name");
    }
    const data = (await this._getJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      ctx,
    )) as Record<string, unknown>;
    const fullName = typeof data["full_name"] === "string" ? data["full_name"] : `${owner}/${repo}`;
    const description = typeof data["description"] === "string" ? data["description"] : "";
    const stars = typeof data["stargazers_count"] === "number" ? data["stargazers_count"] : 0;
    return {
      kind: "repository",
      title: fullName,
      url:
        typeof data["html_url"] === "string"
          ? data["html_url"]
          : `https://github.com/${owner}/${repo}`,
      snippet: excerpt(`${description} (stars: ${stars})`.trim(), 1000),
      owner,
      repo,
    };
  }

  private async _readFile(
    owner: string,
    repo: string,
    filePath: string,
    ctx: AdapterContext,
  ): Promise<GithubResearchItem> {
    if (!safeSegment(owner) || !safeSegment(repo)) {
      throw new ResearchProviderFailed(GITHUB_API_PROVIDER, "Invalid repository owner or name");
    }
    if (filePath.includes("..") || filePath.startsWith("/") || filePath.length > 1024) {
      throw new ResearchProviderFailed(GITHUB_API_PROVIDER, "Invalid repository file path");
    }
    const segments = filePath
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    const data = (await this._getJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${segments}`,
      ctx,
    )) as Record<string, unknown>;
    let snippet = "";
    if (data["type"] === "file" && typeof data["content"] === "string") {
      try {
        const decoded = Buffer.from(String(data["content"]).replace(/\s/g, ""), "base64").toString(
          "utf-8",
        );
        snippet = excerpt(decoded, 1000);
      } catch {
        snippet = "";
      }
    } else if (Array.isArray(data)) {
      snippet = excerpt(
        data
          .slice(0, 20)
          .map((e) => (e as { name?: unknown }).name)
          .filter((n): n is string => typeof n === "string")
          .join(", "),
        1000,
      );
    }
    return {
      kind: "file",
      title: `${owner}/${repo}/${filePath}`,
      url: `https://github.com/${owner}/${repo}/blob/HEAD/${filePath}`,
      snippet,
      owner,
      repo,
      path: filePath,
    };
  }

  private async _readIssue(
    owner: string,
    repo: string,
    issueRef: string,
    ctx: AdapterContext,
  ): Promise<GithubResearchItem> {
    if (!safeSegment(owner) || !safeSegment(repo)) {
      throw new ResearchProviderFailed(GITHUB_API_PROVIDER, "Invalid repository owner or name");
    }
    const match = issueRef.trim().match(/^#?(\d{1,8})$/);
    if (!match) {
      throw new ResearchProviderFailed(GITHUB_API_PROVIDER, "Invalid issue reference");
    }
    const number = match[1];
    const data = (await this._getJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
      ctx,
    )) as Record<string, unknown>;
    const title = typeof data["title"] === "string" ? data["title"] : `Issue #${number}`;
    const body = typeof data["body"] === "string" ? data["body"] : "";
    return {
      kind: "issue",
      title: `#${number} ${title}`.slice(0, 300),
      url:
        typeof data["html_url"] === "string"
          ? data["html_url"]
          : `https://github.com/${owner}/${repo}/issues/${number}`,
      snippet: excerpt(body, 1000),
      owner,
      repo,
    };
  }

  private async _search(
    query: string,
    limit: number,
    ctx: AdapterContext,
  ): Promise<GithubResearchItem[]> {
    if (!query.trim()) {
      return [];
    }
    const data = (await this._getJson(
      `/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`,
      ctx,
    )) as Record<string, unknown>;
    const items = Array.isArray(data["items"]) ? (data["items"] as unknown[]) : [];
    const out: GithubResearchItem[] = [];
    for (const raw of items.slice(0, limit)) {
      if (raw === null || typeof raw !== "object") {
        continue;
      }
      const entry = raw as Record<string, unknown>;
      if (typeof entry["full_name"] !== "string") {
        continue;
      }
      const description = typeof entry["description"] === "string" ? entry["description"] : "";
      out.push({
        kind: "search",
        title: entry["full_name"].slice(0, 300),
        url:
          typeof entry["html_url"] === "string"
            ? entry["html_url"]
            : `https://github.com/${entry["full_name"]}`,
        snippet: excerpt(description, 1000),
      });
    }
    return out;
  }
}
