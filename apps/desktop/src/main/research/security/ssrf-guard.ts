// PR35.7: apps/desktop — SSRF Guard (DNS-backed destination validation)
//
// Invariants:
//   1. Every outbound request AND every redirect hop resolves its hostname
//      and validates every returned address before connecting. The original
//      URL is never trusted after a redirect.
//   2. Blocked: loopback (unless tests explicitly opt out), RFC1918, CGNAT,
//      link-local (incl. 169.254.169.254 cloud metadata), ULA, unspecified,
//      multicast, broadcast, reserved, and documentation ranges — for both
//      IPv4 and IPv6, including IPv4-mapped IPv6 forms.
//   3. Literal IPs are validated without DNS. Hostnames resolve via an
//      injectable resolver (default: node:dns/promises); resolution failure
//      fails closed.
//   4. Residual DNS-rebinding TOCTOU (resolve-then-connect skew) is a known
//      limitation documented in pr-35-research.md; full hardening (connection
//      pinning) is future work, not claimed here.
//
// Security note (read carefully before modifying this file): the numeric
// range checks below intentionally use unsigned BigInt arithmetic over the
// parsed address. Do NOT "simplify" them to string prefix checks — prefixes
// miss hex/octal/obfuscated literal forms that the parser normalizes.

import dns from "node:dns/promises";
import net from "node:net";
import { ResearchSsrfBlocked } from "../research-errors.js";

export type DnsResolveAll = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

async function defaultResolveAll(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
}

export interface SsrfGuardOptions {
  /** Defaults to node:dns/promises lookup. Tests inject a stub. */
  readonly resolveAll?: DnsResolveAll;
  /** Production default true. Tests may set false for loopback fixtures. */
  readonly denyLoopback?: boolean;
  /** Optional extra host allowlist (exact lowercase hostname match). */
  readonly allowedHosts?: readonly string[];
}

function parseIPv4ToBigInt(address: string): bigint | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8n) + BigInt(octet);
  }
  return value;
}

function expandIPv6(address: string): bigint | null {
  const zoneIndex = address.indexOf("%");
  const bare = zoneIndex === -1 ? address : address.slice(0, zoneIndex);
  // IPv4-mapped tail (::ffff:1.2.3.4) — expand via the IPv4 parser.
  const lastColon = bare.lastIndexOf(":");
  if (lastColon !== -1 && bare.slice(lastColon + 1).includes(".")) {
    const tail = parseIPv4ToBigInt(bare.slice(lastColon + 1));
    if (tail === null) return null;
    const head = `${bare.slice(0, lastColon)}:${Number((tail >> 16n) & 0xffffn).toString(16)}:${Number(tail & 0xffffn).toString(16)}`;
    return expandIPv6(head);
  }
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const left = halves[0]!.length > 0 ? halves[0]!.split(":") : [];
  const right = halves.length === 2 && halves[1]!.length > 0 ? halves[1]!.split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (left.length + right.length > 8) return null;
  const missing = 8 - (left.length + right.length);
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) + BigInt(`0x${group}`);
  }
  return value;
}

const V4 = (a: number, b: number, c: number, d: number, bits: number): [bigint, bigint] => {
  const base = (BigInt(a) << 24n) + (BigInt(b) << 16n) + (BigInt(c) << 8n) + BigInt(d);
  return [base >> BigInt(32 - bits), BigInt(32 - bits)];
};

const V6 = (prefix: string, bits: number): [bigint, bigint] => {
  const full = expandIPv6(prefix.includes("::") ? prefix : `${prefix}::`);
  if (full === null) throw new Error(`Invalid IPv6 test prefix "${prefix}"`);
  return [full >> BigInt(128 - bits), BigInt(128 - bits)];
};

/** CIDR ranges that must never be fetched (value computed as unsigned). */
function blockedV4Ranges(): Array<[bigint, bigint, string]> {
  return [
    [...V4(0, 0, 0, 0, 8), "unspecified (0.0.0.0/8)"],
    [...V4(10, 0, 0, 0, 8), "private RFC1918 (10.0.0.0/8)"],
    [...V4(100, 64, 0, 0, 10), "shared CGNAT (100.64.0.0/10)"],
    [...V4(127, 0, 0, 0, 8), "loopback (127.0.0.0/8)"],
    [...V4(169, 254, 0, 0, 16), "link-local incl. cloud metadata (169.254.0.0/16)"],
    [...V4(172, 16, 0, 0, 12), "private RFC1918 (172.16.0.0/12)"],
    [...V4(192, 0, 2, 0, 24), "documentation TEST-NET-1 (192.0.2.0/24)"],
    [...V4(192, 88, 99, 0, 24), "reserved (192.88.99.0/24)"],
    [...V4(192, 168, 0, 0, 16), "private RFC1918 (192.168.0.0/16)"],
    [...V4(198, 18, 0, 0, 15), "benchmarking (198.18.0.0/15)"],
    [...V4(198, 51, 100, 0, 24), "documentation TEST-NET-2 (198.51.100.0/24)"],
    [...V4(203, 0, 113, 0, 24), "documentation TEST-NET-3 (203.0.113.0/24)"],
    [...V4(224, 0, 0, 0, 4), "multicast (224.0.0.0/4)"],
    [...V4(240, 0, 0, 0, 4), "reserved incl. broadcast (240.0.0.0/4)"],
    [...V4(255, 255, 255, 255, 32), "broadcast (255.255.255.255/32)"],
  ];
}

function blockedV6Ranges(denyLoopback: boolean): Array<[bigint, bigint, string]> {
  const ranges: Array<[bigint, bigint, string]> = [
    [...V6("::", 128), "unspecified (::/128)"],
    [...V6("64:ff9b::", 96), "IPv4-embedded translation (64:ff9b::/96)"],
    [...V6("100::", 64), "discard (100::/64)"],
    [...V6("2001::", 23), "special registry (2001::/23)"],
    [...V6("2001:db8::", 32), "documentation (2001:db8::/32)"],
    [...V6("fc00::", 7), "unique-local ULA (fc00::/7)"],
    [...V6("fe80::", 10), "link-local (fe80::/10)"],
    [...V6("ff00::", 8), "multicast (ff00::/8)"],
  ];
  if (denyLoopback) {
    ranges.push([...V6("::1", 128), "loopback (::1/128)"]);
  }
  return ranges;
}

function blockedReasonForAddress(address: string, denyLoopback: boolean): string | null {
  const family = net.isIP(address);
  if (family === 4) {
    const value = parseIPv4ToBigInt(address);
    if (value === null) return `unparseable IPv4 literal "${address}"`;
    for (const [network, shift, label] of blockedV4Ranges()) {
      if (!denyLoopback && label.startsWith("loopback")) continue;
      if (value >> shift === network) return label;
    }
    return null;
  }
  if (family === 6) {
    const value = expandIPv6(address);
    if (value === null) return `unparseable IPv6 literal "${address}"`;
    for (const [network, shift, label] of blockedV6Ranges(denyLoopback)) {
      if (value >> shift === network) return label;
    }
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) carries an embedded IPv4 address:
    // validate the embedded address against the IPv4 ranges too.
    if (value >> 32n === 0xffffn) {
      const embedded = value & 0xffffffffn;
      for (const [network, shift, label] of blockedV4Ranges()) {
        if (!denyLoopback && label.startsWith("loopback")) continue;
        if (embedded >> shift === network) return `IPv4-mapped ${label}`;
      }
    }
    return null;
  }
  return `non-IP address "${address}"`;
}

/**
 * Validates a destination URL: syntactic scheme/host, optional host
 * allowlist, then DNS resolution of every address with range checks.
 * Throws ResearchSsrfBlocked on any failure (fails closed).
 */
export async function assertSafeResearchDestination(
  rawUrl: string,
  options?: SsrfGuardOptions,
): Promise<{ normalizedUrl: string; addresses: string[] }> {
  const denyLoopback = options?.denyLoopback ?? true;
  const resolveAll = options?.resolveAll ?? defaultResolveAll;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new ResearchSsrfBlocked(`Research destination is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ResearchSsrfBlocked(
      `Research destination scheme "${parsed.protocol}" is not allowed`,
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new ResearchSsrfBlocked(`Research destination has no hostname`);
  }
  if (options?.allowedHosts && !options.allowedHosts.includes(hostname)) {
    throw new ResearchSsrfBlocked(`Research host "${hostname}" is not allowlisted`);
  }

  let addresses: string[];
  if (net.isIP(hostname) !== 0) {
    addresses = [hostname];
  } else {
    let records: Array<{ address: string; family: number }>;
    try {
      records = await resolveAll(hostname);
    } catch (err: unknown) {
      throw new ResearchSsrfBlocked(`Research host "${hostname}" failed DNS resolution`, {
        cause: err,
      });
    }
    if (records.length === 0) {
      throw new ResearchSsrfBlocked(`Research host "${hostname}" resolved to no addresses`);
    }
    addresses = records.map((r) => r.address);
  }

  for (const address of addresses) {
    const reason = blockedReasonForAddress(address, denyLoopback);
    if (reason !== null) {
      throw new ResearchSsrfBlocked(`Research destination "${hostname}" blocked: ${reason}`);
    }
  }
  return { normalizedUrl: parsed.toString(), addresses };
}

/** Pure range-check helper exposed for unit tests (no DNS). */
export function blockedReasonForTestAddress(address: string, denyLoopback = true): string | null {
  return blockedReasonForAddress(address, denyLoopback);
}
