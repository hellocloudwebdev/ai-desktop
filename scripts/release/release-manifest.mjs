// release-manifest.mjs — build a JSON manifest describing release artifacts.
//
// Usage:
//   node scripts/release/release-manifest.mjs --dir <artifacts-dir> \
//     --version <ver> --channel <stable|beta|nightly> --repo <owner/repo> \
//     [--out manifest.json]
//
// Scans <artifacts-dir> and emits a JSON array of:
//   { version, channel, platform, arch, artifact, sha256, size, releaseDate }
// Platform is inferred from the extension (.exe -> win, .dmg/.zip -> mac,
// .AppImage -> linux). Arch is inferred from the filename (x64, arm64, …)
// and defaults to "x64". sha256 is read from the sibling .sha256 sidecar when
// present, otherwise computed. Zero dependencies.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const opts = { dir: null, version: null, channel: null, repo: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--dir" && next) opts.dir = next;
    else if (flag === "--version" && next) opts.version = next;
    else if (flag === "--channel" && next) opts.channel = next;
    else if (flag === "--repo" && next) opts.repo = next;
    else if (flag === "--out" && next) opts.out = next;
    else continue;
    if (flag !== "--out" || next) i += 1;
  }
  return opts;
}

function inferPlatform(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".exe")) return "win";
  if (lower.endsWith(".dmg") || lower.endsWith(".zip")) return "mac";
  if (lower.endsWith(".appimage")) return "linux";
  return "unknown";
}

function inferArch(filename) {
  const lower = filename.toLowerCase();
  const match = lower.match(/(arm64|x86_64|x64|ia32|universal)/);
  if (!match) return "x64";
  return match[1] === "x86_64" ? "x64" : match[1];
}

function readOrComputeSha256(full, name) {
  const sidecar = `${full}.sha256`;
  if (fs.existsSync(sidecar)) {
    const first = fs.readFileSync(sidecar, "utf8").trim().split(/\r?\n/)[0] ?? "";
    const [hash] = first.split(/\s+/);
    if (/^[0-9a-f]{64}$/i.test(hash ?? "")) return hash;
  }
  return createHash("sha256").update(fs.readFileSync(full)).digest("hex");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir || !opts.version || !opts.channel || !opts.repo) {
    console.error(
      "Usage: node scripts/release/release-manifest.mjs --dir <artifacts-dir> --version <ver> --channel <stable|beta|nightly> --repo <owner/repo> [--out manifest.json]",
    );
    process.exit(2);
  }
  if (!["stable", "beta", "nightly"].includes(opts.channel)) {
    console.error(`release-manifest: invalid channel: ${opts.channel}`);
    process.exit(2);
  }
  const resolved = path.resolve(opts.dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    console.error(`release-manifest: missing directory: ${resolved}`);
    process.exit(1);
  }
  const releaseDate = new Date().toISOString();
  const entries = [];
  for (const name of fs.readdirSync(resolved).sort()) {
    const full = path.join(resolved, name);
    if (!fs.statSync(full).isFile()) continue;
    const lower = name.toLowerCase();
    if (lower.endsWith(".sha256") || lower.endsWith(".yml") || lower.endsWith(".yaml")) continue;
    if (lower.endsWith(".blockmap") || lower.startsWith("latest")) continue;
    const platform = inferPlatform(name);
    if (platform === "unknown") continue;
    entries.push({
      version: opts.version,
      channel: opts.channel,
      repository: opts.repo,
      platform,
      arch: inferArch(name),
      artifact: name,
      sha256: readOrComputeSha256(full, name),
      size: fs.statSync(full).size,
      releaseDate,
    });
  }
  const json = JSON.stringify(entries, null, 2);
  if (opts.out) fs.writeFileSync(path.resolve(opts.out), `${json}\n`, "utf8");
  console.log(json);
}

main();
