// PR35.17: apps/desktop — GitHub Research Adapter
//
// Invariants:
//   1. Structured REST over api.github.com via fetch. No `gh` subprocess,
//      no shell, no command construction — inputs are URL/query validated.
//   2. Public access works keyless; authenticated access uses SecretRef via
//      the injected resolver. Raw tokens never appear in inputs, outputs,
//      errors, or logs.
//   3. File reads are ref-pinned, base64-decoded, and byte-capped. Search
//      results normalize to SearchResult with github.com provenance.

import {
  canonicalizeResearchUrl,
  dedupeSearchResults,
  type SearchResult,
} from "@ai-desktop/ai-core";
import {
  ResearchAuthRequired,
  ResearchNotFound,
  ResearchProviderError,
  toCanonicalResearchError,
} from "../../research-errors.js";
import type { ResearchPolicy } from "../../research-policy.js";
import {
  createLinkedAbortController,
  defaultResearchPolicy,
  throwIfResearchAborted,
  withResearchTimeout,
} from "../../research-policy.js";
import { fetchWithRedirectPolicy } from "../../security/redirect-policy.js";

export type GithubOperation = "repository" | "file" | "issue" | "pull" | "search";

export interface GithubQuery {
  readonly operation: GithubOperation;
  readonly owner?: string;
  readonly repo?: string;
  readonly path?: string;
  readonly ref?: string;
  readonly number?: number;
  readonly query?: string;
  readonly maxResults?: number;
}

export interface GithubReadOptions {
  readonly signal?: AbortSignal;
  readonly policy?: ResearchPolicy;
  readonly fetchFn?: typeof fetch;
  readonly resolveAll?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export interface GithubResultContent {
  readonly kind: GithubOperation;
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly searchResults?: SearchResult[];
}

export interface GithubResearchDeps {
  readonly policy?: ResearchPolicy;
  readonly fetchFn?: typeof fetch;
  readonly resolveAll?: GithubReadOptions["resolveAll"];
  readonly resolveSecret?: (ref: string) => Promise<string | null>;
  readonly apiKeyRef?: string;
  readonly endpoint?: string;
}

const MAX_GITHUB_FILE_BYTES = 256 * 1024;

/** Structured GitHub adapter over the REST API (no subprocess). */
export class GithubResearchAdapter {
  readonly provider = "github-api";
  private readonly _policy: ResearchPolicy;
  private readonly _fetchFn?: typeof fetch;
  private readonly _resolveAll?: GithubReadOptions["resolveAll"];
  private readonly _resolveSecret?: (ref: string) => Promise<string | null>;
  private readonly _apiKeyRef?: string;
  private readonly _endpoint: string;

  constructor(deps?: GithubResearchDeps) {
    this._policy = deps?.policy ?? defaultResearchPolicy();
    this._fetchFn = deps?.fetchFn;
    this._resolveAll = deps?.resolveAll;
    this._resolveSecret = deps?.resolveSecret;
    this._apiKeyRef = deps?.apiKeyRef;
    this._endpoint = (deps?.endpoint ?? "https://api.github.com").replace(/\/+$/, "");
  }

  get authenticated(): boolean {
    return this._apiKeyRef !== undefined;
  }

  async health(): Promise<"available" | "authRequired" | "unavailable"> {
    return "available";
  }

  async read(query: GithubQuery, options?: GithubReadOptions): Promise<GithubResultContent> {
    const policy = options?.policy ?? this._policy;
    // Abort/cancel inside try/catch so raw AbortErrors canonicalize.
    try {
      throwIfResearchAborted(options?.signal);
      const controller = createLinkedAbortController(options?.signal);
      return await withResearchTimeout(
        this._readInner(query, policy, controller.signal),
        policy.requestTimeoutMs,
        options?.signal,
        () => controller.abort(),
      );
    } catch (err: unknown) {
      throw toCanonicalResearchError(err);
    }
  }

  private _apiUrl(path: string): string {
    return `${this._endpoint}${path}`;
  }

  private async _headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "ai-desktop-research",
    };
    if (this._apiKeyRef && this._resolveSecret) {
      const token = await this._resolveSecret(this._apiKeyRef);
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private async _getJson(
    url: string,
    policy: ResearchPolicy,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: unknown }> {
    const { response } = await fetchWithRedirectPolicy(url, {
      maxRedirects: policy.maxRedirects,
      ...(this._fetchFn ? { fetchFn: this._fetchFn } : {}),
      ...(this._resolveAll ? { resolveAll: this._resolveAll } : {}),
      denyLoopback: policy.denyLoopback,
      ...(policy.allowedHosts ? { allowedHosts: [...policy.allowedHosts] } : {}),
      ...(signal ? { signal } : {}),
      headers: await this._headers(),
    });
    if (response.status === 401 || response.status === 403) {
      throw new ResearchAuthRequired(this.provider, `GitHub API rejected credentials`);
    }
    if (response.status === 404) {
      throw new ResearchNotFound(`GitHub resource not found`);
    }
    if (response.status === 429) {
      throw new ResearchProviderError(this.provider, `GitHub API rate limited (429)`);
    }
    if (!response.ok) {
      throw new ResearchProviderError(
        this.provider,
        `GitHub API failed with status ${response.status}`,
      );
    }
    return { status: response.status, json: (await response.json()) as unknown };
  }

  private _requireRepo(query: GithubQuery): { owner: string; repo: string } {
    if (!query.owner || !query.repo) {
      throw new ResearchProviderError(
        this.provider,
        `GitHub ${query.operation} requires owner and repo`,
      );
    }
    return { owner: query.owner, repo: query.repo };
  }

  private async _readInner(
    query: GithubQuery,
    policy: ResearchPolicy,
    signal?: AbortSignal,
  ): Promise<GithubResultContent> {
    switch (query.operation) {
      case "repository": {
        const { owner, repo } = this._requireRepo(query);
        const { json } = await this._getJson(
          this._apiUrl(`/repos/${owner}/${repo}`),
          policy,
          signal,
        );
        const data = json as Record<string, unknown>;
        const text = [
          `Repository: ${String(data.full_name ?? `${owner}/${repo}`)}`,
          typeof data.description === "string" && data.description
            ? `Description: ${data.description}`
            : "",
          typeof data.language === "string" && data.language ? `Language: ${data.language}` : "",
          typeof data.stargazers_count === "number" ? `Stars: ${data.stargazers_count}` : "",
          typeof data.html_url === "string" ? `URL: ${data.html_url}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return {
          kind: "repository",
          url:
            typeof data.html_url === "string"
              ? data.html_url
              : `https://github.com/${owner}/${repo}`,
          title: String(data.full_name ?? `${owner}/${repo}`),
          text: text.slice(0, policy.maxContentChars),
          truncated: text.length > policy.maxContentChars,
        };
      }
      case "file": {
        const { owner, repo } = this._requireRepo(query);
        if (!query.path) {
          throw new ResearchProviderError(this.provider, `GitHub file read requires path`);
        }
        const refParam = query.ref ? `?ref=${encodeURIComponent(query.ref)}` : "";
        const { json } = await this._getJson(
          this._apiUrl(
            `/repos/${owner}/${repo}/contents/${query.path.split("/").map(encodeURIComponent).join("/")}${refParam}`,
          ),
          policy,
          signal,
        );
        const data = json as Record<string, unknown>;
        if (data.type !== "file" || typeof data.content !== "string") {
          throw new ResearchProviderError(this.provider, `GitHub path is not a readable file`);
        }
        const size = typeof data.size === "number" ? data.size : 0;
        if (size > MAX_GITHUB_FILE_BYTES) {
          throw new ResearchProviderError(
            this.provider,
            `GitHub file exceeds ${MAX_GITHUB_FILE_BYTES} bytes`,
          );
        }
        const text = Buffer.from(String(data.content).replace(/\s/g, ""), "base64").toString(
          "utf-8",
        );
        const sliced = text.slice(0, policy.maxContentChars);
        return {
          kind: "file",
          url:
            typeof data.html_url === "string"
              ? data.html_url
              : `https://github.com/${owner}/${repo}/blob/${query.ref ?? "HEAD"}/${query.path}`,
          title: `${owner}/${repo}/${query.path}`,
          text: sliced,
          truncated: text.length > policy.maxContentChars,
        };
      }
      case "issue":
      case "pull": {
        const { owner, repo } = this._requireRepo(query);
        if (!query.number) {
          throw new ResearchProviderError(
            this.provider,
            `GitHub ${query.operation} requires number`,
          );
        }
        const rest = query.operation === "issue" ? "issues" : "pulls";
        const { json } = await this._getJson(
          this._apiUrl(`/repos/${owner}/${repo}/${rest}/${query.number}`),
          policy,
          signal,
        );
        const data = json as Record<string, unknown>;
        const text = [
          `Title: ${String(data.title ?? "")}`,
          typeof data.body === "string" && data.body ? `\n${data.body}` : "",
        ].join("");
        const sliced = text.slice(0, policy.maxContentChars);
        return {
          kind: query.operation,
          url:
            typeof data.html_url === "string"
              ? data.html_url
              : `https://github.com/${owner}/${repo}/${rest}/${query.number}`,
          title: String(data.title ?? `${rest} #${query.number}`),
          text: sliced,
          truncated: text.length > policy.maxContentChars,
        };
      }
      case "search": {
        if (!query.query) {
          throw new ResearchProviderError(this.provider, `GitHub search requires query`);
        }
        const maxResults = Math.min(
          query.maxResults ?? policy.maxSearchResults,
          policy.maxSearchResults,
        );
        const { json } = await this._getJson(
          this._apiUrl(
            `/search/repositories?q=${encodeURIComponent(query.query)}&per_page=${maxResults}`,
          ),
          policy,
          signal,
        );
        const items = ((json as Record<string, unknown>).items ?? []) as Array<
          Record<string, unknown>
        >;
        const results: SearchResult[] = [];
        for (const item of items.slice(0, maxResults)) {
          const htmlUrl = typeof item.html_url === "string" ? item.html_url : "";
          const canonical = htmlUrl ? canonicalizeResearchUrl(htmlUrl) : null;
          if (!canonical) continue;
          results.push({
            title: String(item.full_name ?? canonical).slice(0, 300),
            url: canonical,
            snippet: typeof item.description === "string" ? item.description.slice(0, 2000) : "",
            domain: "github.com",
          });
        }
        const deduped = dedupeSearchResults(results).slice(0, maxResults);
        const text = deduped
          .map((r) => `- ${r.title}\n  ${r.url}\n  ${r.snippet}`)
          .join("\n")
          .slice(0, policy.maxContentChars);
        return {
          kind: "search",
          url: `https://github.com/search?q=${encodeURIComponent(query.query)}&type=repositories`,
          title: `GitHub search: ${query.query}`,
          text,
          truncated: false,
          searchResults: deduped,
        };
      }
    }
  }
}
