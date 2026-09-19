// PR46 — Production security static gate (`pnpm security:check`).
//
// Wiring: root package.json declares `"security:check": "node scripts/security-check.mjs"`.
// CI parity: run `node scripts/security-check.mjs` alongside
// `pnpm architecture:check` (see .github/workflows/ci.yml — the script exits
// non-zero on any finding so it can gate directly). Unit tests live in
// scripts/security-check.test.mjs (covered by the root vitest include
// `scripts/**\/*.test.mjs`, mirroring the PR2 validator pattern).
//
// What it proves (line-scanner with comment/string awareness, documented
// below — simple robust parsing over brittle grep):
//   1. electron-boundary  — `from "electron"` / require("electron") appears
//      only under apps/desktop/** (constitutional Process Isolation).
//   2. prisma-boundary    — `@prisma/client` imports appear only under
//      packages/storage/** (constitutional Storage Isolation).
//   3. child-process      — `child_process` / `spawn(` / `execFile` appear
//      only in the approved execution boundary:
//        - packages/execution/** (Docker + local sandbox providers own all
//          container/process lifecycle),
//        - apps/desktop/src/main/git/git-cli.ts (argv-only git spawn,
//          shell:false),
//        - apps/desktop/src/main/browser/puppeteer/** (puppeteer adapter
//          boundary; launches via puppeteer-core, never raw spawn),
//        - test harnesses (**/__tests__/**, *.test.*, *.spec.*) which use
//          execFileSync only to set up fixtures (e.g. `git init`).
//   4. no-eval            — `eval(` / `new Function(` never appear in real
//      code (string literals and comments are stripped first, so negative
//      assertions in tests do not trip the gate; zero tolerance otherwise).
//   5. no-execute-channel — no IPC channel literal (any `:`-carrying string
//      literal) contains an execute/eval/spawn *segment* (segments split on
//      : / - _; exact-match so "retrieval"/"interval" never false-positive).
//      Test files are excluded from this rule only (they must be free to
//      assert that forbidden channels are rejected).
//
// Exit codes: 0 when clean, 1 with findings (message per finding).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "coverage",
  ".turbo",
  "out",
  "build",
  ".git",
]);

const FORBIDDEN_CHANNEL_SEGMENTS = new Set(["execute", "eval", "spawn"]);

function isTestPath(relativePosix) {
  return (
    relativePosix.includes("/__tests__/") ||
    relativePosix.endsWith(".test.ts") ||
    relativePosix.endsWith(".test.mjs") ||
    relativePosix.endsWith(".test.js") ||
    relativePosix.endsWith(".spec.ts") ||
    relativePosix.endsWith(".spec.mjs") ||
    relativePosix.endsWith(".spec.js")
  );
}

function isApprovedChildProcessPath(relativePosix) {
  if (isTestPath(relativePosix)) {
    return true;
  }
  if (relativePosix.startsWith("packages/execution/")) {
    return true;
  }
  if (relativePosix === "apps/desktop/src/main/git/git-cli.ts") {
    return true;
  }
  if (relativePosix.startsWith("apps/desktop/src/main/browser/puppeteer/")) {
    return true;
  }
  return false;
}

/** Remove /* … *\/ and // comments, keeping string literals intact. */
export function stripComments(content) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < content.length) {
    const ch = content[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < content.length) {
        out += content[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    if (ch === "/" && content[i + 1] === "/") {
      const end = content.indexOf("\n", i + 2);
      i = end === -1 ? content.length : end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Remove comments AND string/template literals (for eval detection). */
export function stripStringsAndComments(content) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < content.length) {
    const ch = content[i];
    if (quote) {
      if (ch === "\\" && i + 1 < content.length) {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += " ";
      i += 1;
      continue;
    }
    if (ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    if (ch === "/" && content[i + 1] === "/") {
      const end = content.indexOf("\n", i + 2);
      i = end === -1 ? content.length : end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Collect single/double-quoted string literals (comments removed first). */
export function extractStringLiterals(content) {
  const code = stripComments(content);
  const literals = [];
  const pattern = /"([^"\n]*)"|'([^'\n]*)'/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    const value = match[1] ?? match[2] ?? "";
    const line = code.slice(0, match.index).split("\n").length;
    literals.push({ value, line });
  }
  return literals;
}

export function isForbiddenChannelLiteral(value) {
  if (!value.includes(":")) {
    return false;
  }
  if (!/^[\w:./-]+$/.test(value)) {
    return false;
  }
  const segments = value.toLowerCase().split(/[:/_.-]+/);
  return segments.some((segment) => FORBIDDEN_CHANNEL_SEGMENTS.has(segment));
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

export function checkFile(relativePosix, content) {
  const issues = [];
  const code = stripComments(content);
  const bare = stripStringsAndComments(content);

  // Import detection mirrors scripts/validate-dependencies.mjs: static
  // import/export-from patterns are line-anchored so import-looking text
  // inside string literals (e.g. forbidden-lists in negative-assertion
  // tests) is never matched; require()/dynamic import() stay unanchored.
  const ELECTRON_IMPORT_PATTERNS = [
    /^\s*import\s[^;'"]*?from\s*["']electron(?:\/[^"']*)?["']/gm,
    /^\s*export\s[^;'"]*?from\s*["']electron(?:\/[^"']*)?["']/gm,
    /^\s*import\s*["']electron(?:\/[^"']*)?["']/gm,
    /\bimport\s*\(\s*["']electron(?:\/[^"']*)?["']\s*\)/g,
    /\brequire\s*\(\s*["']electron(?:\/[^"']*)?["']\s*\)/g,
  ];
  const PRISMA_IMPORT_PATTERNS = [
    /^\s*import\s[^;'"]*?from\s*["']@prisma\/client(?:\/[^"']*)?["']/gm,
    /^\s*export\s[^;'"]*?from\s*["']@prisma\/client(?:\/[^"']*)?["']/gm,
    /^\s*import\s*["']@prisma\/client(?:\/[^"']*)?["']/gm,
    /\bimport\s*\(\s*["']@prisma\/client(?:\/[^"']*)?["']\s*\)/g,
    /\brequire\s*\(\s*["']@prisma\/client(?:\/[^"']*)?["']\s*\)/g,
  ];
  // child_process *imports* (specifier-level, line-anchored like above).
  const CHILD_IMPORT_PATTERNS = [
    /^\s*import\s[^;'"]*?from\s*["'](?:node:)?child_process["']/gm,
    /^\s*export\s[^;'"]*?from\s*["'](?:node:)?child_process["']/gm,
    /^\s*import\s*["'](?:node:)?child_process["']/gm,
    /\bimport\s*\(\s*["'](?:node:)?child_process["']\s*\)/g,
    /\brequire\s*\(\s*["'](?:node:)?child_process["']\s*\)/g,
  ];

  // 1. electron boundary (imports only under apps/desktop/).
  if (!relativePosix.startsWith("apps/desktop/")) {
    for (const pattern of ELECTRON_IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(code)) !== null) {
        issues.push({
          rule: "electron-boundary",
          message: `${relativePosix}:${lineOf(code, match.index)}: "electron" may only be imported inside apps/desktop`,
          file: relativePosix,
          line: lineOf(code, match.index),
        });
      }
    }
  }

  // 2. prisma boundary (imports only under packages/storage/).
  if (!relativePosix.startsWith("packages/storage/")) {
    for (const pattern of PRISMA_IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(code)) !== null) {
        issues.push({
          rule: "prisma-boundary",
          message: `${relativePosix}:${lineOf(code, match.index)}: "@prisma/client" may only be imported inside packages/storage`,
          file: relativePosix,
          line: lineOf(code, match.index),
        });
      }
    }
  }

  // 3. child_process containment (approved boundary files only).
  // Imports match on comment-stripped code; spawn/execFile *calls* match on
  // string-stripped code so message strings and forbidden-lists that merely
  // name these APIs never trip the gate — only real imports and calls do.
  if (!isApprovedChildProcessPath(relativePosix)) {
    for (const pattern of CHILD_IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(code)) !== null) {
        issues.push({
          rule: "child-process",
          message: `${relativePosix}:${lineOf(code, match.index)}: child_process import outside the approved execution boundary (packages/execution, git-cli, puppeteer adapter, tests)`,
          file: relativePosix,
          line: lineOf(code, match.index),
        });
      }
    }
    const spawnPattern = /\bspawn\s*\(|\bexecFileSync?\s*\(/g;
    let spawnMatch;
    while ((spawnMatch = spawnPattern.exec(bare)) !== null) {
      issues.push({
        rule: "child-process",
        message: `${relativePosix}:${lineOf(bare, spawnMatch.index)}: spawn/execFile call outside the approved execution boundary (packages/execution, git-cli, puppeteer adapter, tests)`,
        file: relativePosix,
        line: lineOf(bare, spawnMatch.index),
      });
    }
  }

  // 4. no eval / new Function (strings + comments stripped; zero tolerance).
  const evalPattern = /\beval\s*\(|\bnew\s+Function\s*\(/g;
  let evalMatch;
  while ((evalMatch = evalPattern.exec(bare)) !== null) {
    issues.push({
      rule: "no-eval",
      message: `${relativePosix}:${lineOf(bare, evalMatch.index)}: eval/new Function is forbidden`,
      file: relativePosix,
      line: lineOf(bare, evalMatch.index),
    });
  }

  // 5. no execute/eval/spawn IPC channel (test files excluded so they can
  //    assert rejection of forbidden channels).
  if (!isTestPath(relativePosix)) {
    for (const { value, line } of extractStringLiterals(content)) {
      if (isForbiddenChannelLiteral(value)) {
        issues.push({
          rule: "no-execute-channel",
          message: `${relativePosix}:${line}: forbidden IPC channel "${value}" (execute/eval/spawn segments are never allowed)`,
          file: relativePosix,
          line,
        });
      }
    }
    const invokePattern = /\.invoke\s*\(\s*["']([^"']+)["']/g;
    let invokeMatch;
    while ((invokeMatch = invokePattern.exec(code)) !== null) {
      if (isForbiddenChannelLiteral(invokeMatch[1])) {
        issues.push({
          rule: "no-execute-channel",
          message: `${relativePosix}:${lineOf(code, invokeMatch.index)}: forbidden .invoke channel "${invokeMatch[1]}"`,
          file: relativePosix,
          line: lineOf(code, invokeMatch.index),
        });
      }
    }
  }

  return issues;
}

function walkSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        walkSourceFiles(path.join(dir, entry.name), out);
      }
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }
    out.push(path.join(dir, entry.name));
  }
  return out;
}

export function checkRepository(repoRoot) {
  const issues = [];
  const stats = { filesScanned: 0 };
  let files = [];
  try {
    files = walkSourceFiles(repoRoot);
  } catch {
    return { issues, stats };
  }
  for (const file of files) {
    const relativePosix = path.relative(repoRoot, file).split(path.sep).join("/");
    if (relativePosix.startsWith("node_modules/")) {
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    stats.filesScanned += 1;
    issues.push(...checkFile(relativePosix, content));
  }
  return { issues, stats };
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { issues, stats } = checkRepository(repoRoot);
  if (issues.length > 0) {
    console.error(`security:check FAILED — ${issues.length} issue(s)\n`);
    for (const issue of issues) {
      console.error(`  [${issue.rule}] ${issue.message}`);
    }
    console.error(`\nScanned ${stats.filesScanned} source files.`);
    process.exitCode = 1;
    return;
  }
  console.log(`security:check OK — ${stats.filesScanned} source files; no forbidden boundaries.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
