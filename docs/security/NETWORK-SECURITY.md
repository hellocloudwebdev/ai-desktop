# Network Security — SSRF / Redirect / DNS Policy (PR46)

Covers the audited network egress path: web research fetch
(`apps/desktop/src/main/research/security/`, verified). Provider SDK calls
(Anthropic/Google) and MCP remote transports are separate egress with
their own verification status noted below.

## 1. SSRF guard policy

Every outbound research request and every redirect hop is validated
(`ssrf-guard.ts`, verified):

- Rejected holders: loopback, RFC1918 private IPv4, private IPv6,
  link-local, CGNAT, cloud-metadata addresses, multicast.
- Fail-closed DNS: unresolvable hosts reject; no bypass on lookup failure.
- Every redirect destination is re-resolved and re-checked (DNS-rebinding
  protection) with a hard redirect ceiling (`secure-fetch.ts`: manual
  redirect handling, per-hop re-validation).
- `allowedHosts` is a host-controlled, test-only escape hatch — never user
  input, never persisted from renderer data.

## 2. Private-range stance

**Default deny.** Private ranges are unreachable through the research path,
including via redirects. There is no per-user allowlist, no "intranet
mode", and no configuration surface that re-opens them. Any future
exception requires an ADR, a closed host allowlist, and per-hop
re-validation — not a user toggle.

## 3. Localhost exception path (documentation)

There is **no localhost exception** in the verified guard: loopback is
rejected like any other private holder. The only documented bypass is the
`allowedHosts` test hatch, which is code-controlled (test fixtures), not a
runtime setting. Developer-loopback scenarios must go through that hatch
in test code, never through production configuration.

## 4. `secureFetch` bounds

Compressed/decompressed size caps, content-type policy, overall timeout,
`AbortSignal` cancellation, model-safe errors (no credential/header echo).
Audit slot for blocks: `security.network.blocked`.

## 5. Out-of-scope / not-verified egress

- Provider SDK traffic (Anthropic/Google endpoints): TLS via the SDKs;
  credential resolution via `SecretRef`; no additional app-level egress
  guard was verified — the SDKs are trusted to contact their own endpoints.
- MCP `streamable-http`/SSE transports: URI validation and secretRef env
  handling verified at the host; full egress policy for arbitrary remote
  MCP servers is the operator's trust decision (see `EXTENSIONS.md`).
- No app-wide egress firewall or proxy support was verified.

## 6. Residual risks (honest)

- No verified connection-level IP pinning: a residual check-to-connect
  race exists (T17).
- Query-parameter exfiltration to a public attacker URL is not SSRF and is
  not blocked; response bodies are untrusted data (see T16/T20).
