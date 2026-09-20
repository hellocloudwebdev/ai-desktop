// checksums.mjs — generate SHA-256 sidecar files for release artifacts.
//
// Usage: node scripts/release/checksums.mjs <artifacts-dir>
//
// For each regular file in <artifacts-dir> (excluding *.sha256, *.yml,
// *.yaml, and latest*.json), writes a sibling `<name>.sha256` containing
// "<hash>  <filename>\n" (SHA-256 hex) and prints manifest lines.
// Zero dependencies (node:crypto, node:fs, node:path only).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EXCLUDED_EXTENSIONS = new Set([".sha256", ".yml", ".yaml"]);

function isExcluded(name) {
  if (name.startsWith("latest")) return true;
  const ext = path.extname(name).toLowerCase();
  return EXCLUDED_EXTENSIONS.has(ext);
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node scripts/release/checksums.mjs <artifacts-dir>");
    process.exit(2);
  }
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    console.error(`checksums: missing directory: ${resolved}`);
    process.exit(1);
  }
  const entries = fs.readdirSync(resolved).sort();
  let count = 0;
  for (const name of entries) {
    const full = path.join(resolved, name);
    if (!fs.statSync(full).isFile()) continue;
    if (isExcluded(name)) continue;
    const data = fs.readFileSync(full);
    const hash = createHash("sha256").update(data).digest("hex");
    fs.writeFileSync(`${full}.sha256`, `${hash}  ${name}\n`, "utf8");
    console.log(`${hash}  ${name}`);
    count += 1;
  }
  if (count === 0) {
    console.error("checksums: no artifact files found to hash.");
    process.exit(1);
  }
}

main();
