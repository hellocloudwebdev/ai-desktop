// artifact-validation.mjs — validate electron-builder release artifacts.
//
// Usage: node scripts/release/artifact-validation.mjs <artifacts-dir> [--app-version X]
//
// Checks:
//   1. dir exists and is a directory.
//   2. at least one installer artifact is present (*.exe, *.dmg, *.AppImage, *.zip).
//   3. each installer artifact has a sibling .sha256 that verifies.
//   4. an update manifest exists (latest.yml or latest-*.yml), parses as
//      YAML-ish, and contains `version:` plus a url/path entry.
//   5. size sanity: every installer artifact is > 20 MB.
// Prints PASS/FAIL per check; exits non-zero on any failure. Zero dependencies.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const INSTALLER_EXTENSIONS = new Set([".exe", ".dmg", ".appimage", ".zip"]);
const MIN_INSTALLER_BYTES = 20 * 1024 * 1024;

function parseArgs(argv) {
  const dir = argv[0];
  let appVersion = null;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--app-version" && i + 1 < argv.length) {
      appVersion = argv[i + 1];
      i += 1;
    }
  }
  return { dir, appVersion };
}

function listFiles(dir) {
  return fs
    .readdirSync(dir)
    .sort()
    .filter((name) => fs.statSync(path.join(dir, name)).isFile());
}

function findInstallers(files) {
  return files.filter((name) => {
    const lower = name.toLowerCase();
    if (lower.endsWith(".sha256")) return false;
    if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return false;
    if (lower.endsWith(".blockmap")) return false;
    return INSTALLER_EXTENSIONS.has(path.extname(lower));
  });
}

// Minimal YAML-ish parser: top-level `key: value` pairs + `- url/path:` list items.
function parseManifestSummary(text) {
  const summary = { topKeys: new Map(), listKeys: new Set() };
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const listMatch = trimmed.match(/^-\s*([A-Za-z0-9_-]+)\s*:/);
    if (listMatch) summary.listKeys.add(listMatch[1].toLowerCase());
    const topMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (topMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      summary.topKeys.set(topMatch[1].toLowerCase(), topMatch[2].trim());
    } else if (topMatch && !summary.topKeys.has(topMatch[1].toLowerCase())) {
      summary.topKeys.set(topMatch[1].toLowerCase(), topMatch[2].trim());
    }
  }
  return summary;
}

function main() {
  const { dir, appVersion } = parseArgs(process.argv.slice(2));
  const results = [];
  const record = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  if (!dir) {
    console.error(
      "Usage: node scripts/release/artifact-validation.mjs <artifacts-dir> [--app-version X]",
    );
    process.exit(2);
  }
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    record("artifacts-dir-exists", false, `missing directory: ${resolved}`);
    process.exit(1);
  }
  record("artifacts-dir-exists", true, resolved);

  const files = listFiles(resolved);
  const installers = findInstallers(files);
  record(
    "installer-present",
    installers.length > 0,
    installers.length > 0 ? installers.join(", ") : "no *.exe/*.dmg/*.AppImage/*.zip found",
  );

  let checksumsOk = installers.length > 0;
  for (const name of installers) {
    const full = path.join(resolved, name);
    const sidecar = `${full}.sha256`;
    if (!fs.existsSync(sidecar)) {
      record(`sha256:${name}`, false, "missing sibling .sha256");
      checksumsOk = false;
      continue;
    }
    const sidecarText = fs.readFileSync(sidecar, "utf8").trim().split(/\r?\n/)[0] ?? "";
    const [expected] = sidecarText.split(/\s+/);
    const actual = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    const ok = expected === actual;
    if (!ok) checksumsOk = false;
    record(
      `sha256:${name}`,
      ok,
      ok ? "verified" : `mismatch (expected ${expected}, got ${actual})`,
    );
  }
  if (installers.length === 0) record("sha256-verified", false, "no installers to verify");
  else
    record("sha256-verified", checksumsOk, checksumsOk ? "all verified" : "see per-file results");

  const manifests = files.filter((n) => {
    const l = n.toLowerCase();
    return (
      l === "latest.yml" ||
      (l.startsWith("latest-") && (l.endsWith(".yml") || l.endsWith(".yaml"))) ||
      l === "stable.yml" ||
      (l.startsWith("stable-") && (l.endsWith(".yml") || l.endsWith(".yaml")))
    );
  });
  if (manifests.length === 0) {
    record("update-manifest", false, "no latest.yml / latest-*.yml / stable.yml found");
  } else {
    let okAll = true;
    for (const name of manifests) {
      const text = fs.readFileSync(path.join(resolved, name), "utf8");
      const summary = parseManifestSummary(text);
      const hasVersion = summary.topKeys.has("version");
      const hasTarget =
        summary.listKeys.has("url") ||
        summary.listKeys.has("path") ||
        /url\s*:|path\s*:/i.test(text);
      let versionMatch = true;
      if (appVersion && hasVersion) {
        versionMatch =
          (summary.topKeys.get("version") ?? "").replace(/^['"]|['"]$/g, "") === appVersion;
      }
      const ok = hasVersion && hasTarget && versionMatch;
      if (!ok) okAll = false;
      record(
        `update-manifest:${name}`,
        ok,
        ok
          ? `version ${summary.topKeys.get("version")}`
          : `requires version: + url/path entries${appVersion ? ` (expected version ${appVersion})` : ""}`,
      );
    }
    record("update-manifest", okAll, okAll ? manifests.join(", ") : "see per-file results");
  }

  let sizeOk = installers.length > 0;
  for (const name of installers) {
    const size = fs.statSync(path.join(resolved, name)).size;
    const ok = size > MIN_INSTALLER_BYTES;
    if (!ok) sizeOk = false;
    record(`size:${name}`, ok, `${(size / 1024 / 1024).toFixed(1)} MB (min 20 MB)`);
  }
  if (installers.length === 0) record("size-sanity", false, "no installers to measure");
  else
    record("size-sanity", sizeOk, sizeOk ? "all installers > 20 MB" : "undersized installer found");

  const failed = results.some((r) => !r.ok);
  if (failed) process.exit(1);
  console.log("All artifact checks passed.");
}

main();
