// PR35: apps/desktop — SSRF Guard & URL Policy
//
// Mandatory protection for every outbound research request and redirect hop:
//   1. Scheme allowlist: only http: and https:.
//   2. DNS resolution of the hostname before connection.
//   3. Rejection of loopback, RFC1918 private IPv4, private IPv6, link-local,
//      carrier-grade NAT, and cloud metadata-service addresses.
//   4. Re-validation of every redirect destination after resolution (DNS
//      rebinding protection).
//   5. No secrets, credentials, or internal hostnames leak into errors.

import dns from "node:dns";
import net from "node:net";
import { isSafeResearchUrl, MAX_REDIRECTS } from "@ai-desktop/ai-core";
import {
  ResearchRedirectRejected,
  ResearchSsrfBlocked,
  ResearchUrlRejected,
} from "../research-errors.js";

const LOOPBACK_V4 = { first: 0x7f000000, last: 0x7fffffff };
const PRIVATE_V4_RANGES = [
  { first: 0x0a000000, last: 0x0affffff },
  { first: 0xac100000, last: 0xac1fffff },
  { first: 0xc0a80000, last: 0xc0a8ffff },
];
const LINK_LOCAL_V4 = { first: 0xa9fe0000, last: 0xa9feffff };
const CARRIER_GRADE_NAT_V4 = { first: 0x64400000, last: 0x647fffff };
const MULTICAST_V4 = { first: 0xe0000000, last: 0xefffffff };

const CLOUD_METADATA_V4 = new Set(["169.254.169.254", "169.254.169.253", "100.100.100.200"]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function inRange(value: number, range: { first: number; last: number }): boolean {
  return value >= range.first && value <= range.last;
}

function isBlockedIpv4Address(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) {
    return true;
  }
  if (CLOUD_METADATA_V4.has(ip)) {
    return true;
  }
  if (inRange(value, LOOPBACK_V4)) {
    return true;
  }
  for (const range of PRIVATE_V4_RANGES) {
    if (inRange(value, range)) {
      return true;
    }
  }
  if (inRange(value, LINK_LOCAL_V4)) {
    return true;
  }
  if (inRange(value, CARRIER_GRADE_NAT_V4)) {
    return true;
  }
  if (inRange(value, MULTICAST_V4)) {
    return true;
  }
  if (value === 0x00000000 || value === 0xffffffff) {
    return true;
  }
  return false;
}

function expandIpv6(ip: string): number[] | null {
  const lower = ip.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(lower)) {
    return null;
  }
  // Handle IPv4-mapped IPv6 (::ffff:127.0.0.1)
  const mapped = lower.match(/^(.*):(\d+\.\d+\.\d+\.\d+)$/);
  let head = lower;
  let tail: number[] = [];
  if (mapped) {
    const v4 = ipv4ToInt(mapped[2]);
    if (v4 === null) {
      return null;
    }
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    head = mapped[1];
  }
  const halves = head.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(":").filter((p) => p.length > 0) : [];
  const right =
    halves.length === 2 && halves[1] ? halves[1].split(":").filter((p) => p.length > 0) : [];
  const parseGroup = (g: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(g)) {
      return null;
    }
    return parseInt(g, 16);
  };
  const leftVals: number[] = [];
  for (const g of left) {
    const v = parseGroup(g);
    if (v === null) {
      return null;
    }
    leftVals.push(v);
  }
  const rightVals: number[] = [];
  for (const g of right) {
    const v = parseGroup(g);
    if (v === null) {
      return null;
    }
    rightVals.push(v);
  }
  if (halves.length === 1) {
    if (leftVals.length + tail.length !== 8) {
      return null;
    }
    return [...leftVals, ...tail];
  }
  const zeros = 8 - leftVals.length - rightVals.length - tail.length;
  if (zeros < 1) {
    return null;
  }
  return [...leftVals, ...Array<number>(zeros).fill(0), ...rightVals, ...tail];
}

function isBlockedIpv6Address(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (!groups) {
    return true;
  }
  // ::1 loopback
  if (groups.every((g, i) => g === (i === 7 ? 1 : 0))) {
    return true;
  }
  // :: (unspecified)
  if (groups.every((g) => g === 0)) {
    return true;
  }
  // fe80::/10 link-local
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true;
  }
  // fc00::/7 unique local
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true;
  }
  // ff00::/8 multicast
  if ((groups[0] & 0xff00) === 0xff00) {
    return true;
  }
  // 100::/64 discard
  if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) {
    return true;
  }
  // 64:ff9b::/96 translation prefix
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    const v4 = ((groups[6] ?? 0) << 16) + (groups[7] ?? 0);
    return isBlockedIpv4Address(
      `${(v4 >>> 24) & 0xff}.${(v4 >>> 16) & 0xff}.${(v4 >>> 8) & 0xff}.${v4 & 0xff}`,
    );
  }
  // ::ffff:0:0/96 IPv4-mapped — validate the embedded IPv4
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = ((groups[6] ?? 0) << 16) + (groups[7] ?? 0);
    return isBlockedIpv4Address(
      `${(v4 >>> 24) & 0xff}.${(v4 >>> 16) & 0xff}.${(v4 >>> 8) & 0xff}.${v4 & 0xff}`,
    );
  }
  return false;
}

export function isBlockedIpAddress(ip: string): boolean {
  if (typeof ip !== "string" || ip.length === 0) {
    return true;
  }
  const family = net.isIP(ip);
  if (family === 4) {
    return isBlockedIpv4Address(ip);
  }
  if (family === 6) {
    return isBlockedIpv6Address(ip);
  }
  return true;
}

export interface DnsResolver {
  lookup(hostname: string): Promise<Array<{ address: string; family: number }>>;
}

export const defaultDnsResolver: DnsResolver = {
  async lookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
    return dns.promises.lookup(hostname, { all: true });
  },
};

/**
 * Validates a URL string syntactically (scheme + parseability). Throws
 * ResearchUrlRejected for dangerous schemes or malformed URLs. Does NOT
 * resolve DNS — use assertHostAllowed for the resolution step.
 */
export function assertUrlSyntaxAllowed(rawUrl: string): URL {
  if (!isSafeResearchUrl(rawUrl)) {
    throw new ResearchUrlRejected(rawUrl, `URL rejected: scheme or syntax not allowed`);
  }
  try {
    return new URL(rawUrl.trim());
  } catch {
    throw new ResearchUrlRejected(rawUrl, "URL rejected: malformed URL");
  }
}

export interface SsrfAllowlist {
  /**
   * Host-controlled bypass entries for trusted test/development origins.
   * Entries are exact lowercase hostnames or literal IPs. Never populated
   * from model input. Empty by default (fail closed).
   */
  readonly allowedHosts?: readonly string[];
}

function isAllowlisted(hostname: string, allowlist?: SsrfAllowlist): boolean {
  if (!allowlist?.allowedHosts || allowlist.allowedHosts.length === 0) {
    return false;
  }
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return allowlist.allowedHosts.some((entry) => entry.trim().toLowerCase() === normalized);
}

/**
 * Resolves a hostname and rejects it when every/no resolved address is
 * safe. Throws ResearchSsrfBlocked when the destination is internal.
 * Hostnames that fail DNS resolution throw ResearchSsrfBlocked (fail closed).
 * Host-controlled allowlist entries bypass range checks (test origins).
 */
export async function assertHostAllowed(
  hostname: string,
  resolver: DnsResolver = defaultDnsResolver,
  allowlist?: SsrfAllowlist,
): Promise<readonly string[]> {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.length === 0) {
    throw new ResearchSsrfBlocked("Outbound request blocked: empty hostname");
  }
  if (isAllowlisted(normalized, allowlist)) {
    // Allowlisted origin: still require successful resolution (or a literal
    // IP) so typos fail closed instead of connecting blindly.
    if (net.isIP(normalized) !== 0) {
      return [normalized];
    }
    try {
      const records = await resolver.lookup(normalized);
      const addrs = records.map((r) => r.address);
      if (addrs.length === 0) {
        throw new ResearchSsrfBlocked("Outbound request blocked: DNS resolution failed");
      }
      return addrs;
    } catch {
      throw new ResearchSsrfBlocked("Outbound request blocked: DNS resolution failed");
    }
  }
  // Literal IPs are checked without DNS.
  if (net.isIP(normalized) !== 0) {
    if (isBlockedIpAddress(normalized)) {
      throw new ResearchSsrfBlocked("Outbound request blocked: destination is internal");
    }
    return [normalized];
  }
  if (normalized === "localhost") {
    throw new ResearchSsrfBlocked("Outbound request blocked: destination is internal");
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await resolver.lookup(normalized);
  } catch {
    throw new ResearchSsrfBlocked("Outbound request blocked: DNS resolution failed");
  }
  if (!records || records.length === 0) {
    throw new ResearchSsrfBlocked("Outbound request blocked: DNS resolution failed");
  }
  const safe = records.map((r) => r.address).filter((addr) => !isBlockedIpAddress(addr));
  if (safe.length === 0) {
    throw new ResearchSsrfBlocked("Outbound request blocked: destination is internal");
  }
  return safe;
}

/**
 * Full pre-request validation: syntax + DNS + SSRF. Returns the parsed URL
 * and the safe resolved addresses for diagnostics (never logged verbatim).
 */
export async function validateOutboundUrl(
  rawUrl: string,
  resolver: DnsResolver = defaultDnsResolver,
  allowlist?: SsrfAllowlist,
): Promise<{ url: URL; addresses: readonly string[] }> {
  const url = assertUrlSyntaxAllowed(rawUrl);
  const addresses = await assertHostAllowed(url.hostname, resolver, allowlist);
  return { url, addresses };
}

export function resolveRedirectUrl(currentUrl: string, location: string): URL {
  let next: URL;
  try {
    next = new URL(location, currentUrl);
  } catch {
    throw new ResearchRedirectRejected("Redirect rejected: malformed location");
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new ResearchRedirectRejected("Redirect rejected: forbidden scheme");
  }
  if (!next.hostname) {
    throw new ResearchRedirectRejected("Redirect rejected: empty hostname");
  }
  return next;
}

/**
 * Validates a redirect hop: resolves the absolute destination, re-checks
 * scheme + SSRF, and enforces the redirect count bound.
 */
export async function validateRedirect(
  currentUrl: string,
  location: string,
  hopIndex: number,
  maxRedirects: number = MAX_REDIRECTS,
  resolver: DnsResolver = defaultDnsResolver,
  allowlist?: SsrfAllowlist,
): Promise<URL> {
  if (hopIndex >= maxRedirects) {
    throw new ResearchRedirectRejected("Redirect rejected: too many redirects");
  }
  const next = resolveRedirectUrl(currentUrl, location);
  await assertHostAllowed(next.hostname, resolver, allowlist);
  return next;
}
