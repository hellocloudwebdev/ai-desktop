// PR2 — Dependency & architectural enforcement (validator).
//
// One pass over the workspace proving that package.json declarations, actual
// imports, and docs/architecture/dependency-graph.json agree:
//
//   1. graph consistency  — every workspace package exists in the graph (and
//      vice versa) with a matching package.json name
//   2. declaration        — every imported package is declared in the importing
//                           package's package.json (never rely on pnpm hoisting)
//   3. architecture       — every @ai-desktop/* import is an edge allowed by the
//                           graph, and every declared @ai-desktop/* dependency is
//                           an allowed edge (declared-but-forbidden also fails)
//   4. workspace protocol — internal dependencies use the workspace: protocol
//   5. relative escapes   — relative imports never cross a package boundary
//   6. Electron boundary  — electron is imported/declared only by apps/desktop
//
// The ESLint layer (scripts/eslint-package-config.mjs) enforces the same
// internal edges at AST level. This script is the declarative/structural net
// and the CI gate (`pnpm architecture:check`).

import { builtinModules } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".turbo", "out", "build"]);
// ESLint config files are lint tooling, not runtime architecture; their imports
// are resolved by Node itself and they are the ESLint layer's concern.
const ESLINT_CONFIG_FILE = /(^|[/\\])eslint\.config\.[cm]?[jt]sx?$/;
// Mirrors pnpm-workspace.yaml ("packages/*", "apps/*"). If the workspace globs
// change, this list and the graph must be updated together.
const WORKSPACE_ROOTS = ["packages", "apps"];
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const ELECTRON = "electron";

// Line-anchored so that import-looking text inside string literals is not
// matched; [^;'"]* keeps a match from crossing statements or into strings.
const IMPORT_PATTERNS = [
  /^\s*import\s[^;'"]*?from\s*['"]([^'"]+)['"]/gm,
  /^\s*export\s[^;'"]*?from\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function loadGraph(repoRoot) {
  const graphPath = path.join(repoRoot, "docs", "architecture", "dependency-graph.json");
  const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
  if (typeof graph.scope !== "string" || !graph.scope.startsWith("@")) {
    throw new Error(`dependency-graph.json: invalid "scope": ${JSON.stringify(graph.scope)}`);
  }
  if (!graph.packages || typeof graph.packages !== "object") {
    throw new Error('dependency-graph.json: missing "packages"');
  }
  return graph;
}

export function extractImports(content) {
  const imports = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      imports.push({
        specifier: match[1],
        line: content.slice(0, match.index).split("\n").length,
      });
    }
  }
  return imports;
}

function isBuiltinSpecifier(specifier) {
  return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

function internalBasePackage(specifier, scope) {
  if (!specifier.startsWith(`${scope}/`)) return null;
  const base = specifier.split("/").slice(0, 2).join("/");
  return base === scope ? null : base; // bare scope ("@ai-desktop/x" handled) — scope alone is not a package
}

function walkSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        walkSourceFiles(path.join(dir, entry.name), out);
      }
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    if (ESLINT_CONFIG_FILE.test(entry.name)) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

function isInsideDir(parentDir, candidate) {
  const rel = path.relative(parentDir, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function analyzePackage(key, node, graph, repoRoot, issues, stats) {
  const scope = graph.scope;
  const pkgDir = path.resolve(repoRoot, node.directory);
  const pkgJsonPath = path.join(pkgDir, "package.json");

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  } catch {
    issues.push({
      rule: "graph-consistency",
      message: `${node.directory}: missing or unreadable package.json (required by dependency-graph.json)`,
    });
    return;
  }

  const expectedName = `${scope}/${key}`;
  if (pkg.name !== expectedName) {
    issues.push({
      rule: "graph-consistency",
      message: `${node.directory}: package.json name is ${JSON.stringify(pkg.name)}, graph expects ${JSON.stringify(expectedName)}`,
    });
  }

  const declared = {};
  for (const field of DEP_FIELDS) {
    for (const [name, version] of Object.entries(pkg[field] ?? {})) {
      declared[name] = { field, version };
    }
  }

  for (const [name, { field, version }] of Object.entries(declared)) {
    if (name === ELECTRON && key !== "desktop") {
      issues.push({
        rule: "electron-boundary",
        message: `${scope}/${key} declares "electron" in ${field}; only apps/desktop may depend on it`,
      });
      continue;
    }
    const base = internalBasePackage(name, scope);
    if (base === null) continue;
    stats.declarationsChecked++;
    const baseKey = base.slice(scope.length + 1);
    if (!graphNodes(graph)[baseKey]) {
      issues.push({
        rule: "unknown-internal-package",
        message: `${scope}/${key} declares ${name} in ${field}, but it is not defined in dependency-graph.json`,
      });
      continue;
    }
    if (!node.internalDependencies.includes(baseKey)) {
      issues.push({
        rule: "forbidden-edge",
        message: `${scope}/${key} declares ${name} in ${field}, but the dependency graph does not allow ${key} -> ${baseKey}`,
      });
    }
    if (!version.startsWith("workspace:")) {
      issues.push({
        rule: "workspace-protocol",
        message: `${scope}/${key} declares ${name} with "${version}"; internal dependencies must use the workspace: protocol`,
      });
    }
  }

  const files = fs.existsSync(pkgDir) ? walkSourceFiles(pkgDir) : [];
  stats.filesScanned += files.length;

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const { specifier, line } of extractImports(content)) {
      stats.importsChecked++;
      const relFile = path.relative(repoRoot, file);

      const isRelative = specifier.startsWith(".") || specifier.startsWith("..");
      if (isRelative) {
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!isInsideDir(pkgDir, resolved)) {
          issues.push({
            rule: "relative-escape",
            message: `${relFile}:${line}: relative import "${specifier}" crosses the ${scope}/${key} package boundary; import the package by name instead`,
            file: relFile,
            line,
          });
        }
        continue;
      }

      if (isBuiltinSpecifier(specifier)) continue;

      if (specifier === ELECTRON || specifier.startsWith(`${ELECTRON}/`)) {
        if (key !== "desktop") {
          issues.push({
            rule: "electron-boundary",
            message: `${relFile}:${line}: "${specifier}" may only be imported inside apps/desktop`,
            file: relFile,
            line,
          });
        }
        continue;
      }

      const base = internalBasePackage(specifier, scope);
      if (base !== null) {
        const baseKey = base.slice(scope.length + 1);
        if (base === pkg.name) continue; // self-import
        if (!graphNodes(graph)[baseKey]) {
          issues.push({
            rule: "unknown-internal-package",
            message: `${relFile}:${line}: import "${specifier}" is not a package defined in dependency-graph.json`,
            file: relFile,
            line,
          });
          continue;
        }
        if (!declared[base]) {
          issues.push({
            rule: "undeclared-dependency",
            message: `${relFile}:${line}: import "${specifier}" is not declared in ${scope}/${key}/package.json`,
            file: relFile,
            line,
          });
          continue;
        }
        if (!node.internalDependencies.includes(baseKey)) {
          issues.push({
            rule: "forbidden-edge",
            message: `${relFile}:${line}: ${key} -> ${baseKey} is not an edge allowed by dependency-graph.json`,
            file: relFile,
            line,
          });
        }
        continue;
      }

      if (!declared[specifier]) {
        issues.push({
          rule: "undeclared-dependency",
          message: `${relFile}:${line}: import "${specifier}" is not declared in ${scope}/${key}/package.json`,
          file: relFile,
          line,
        });
      }
    }
  }
}

// Kept internal; nodes = canonical packages + applications, keyed by package key.
function graphNodes(graph) {
  return { ...graph.packages, ...graph.applications };
}

export function validateRepository(repoRoot) {
  const graph = loadGraph(repoRoot);
  const nodes = graphNodes(graph);
  const issues = [];
  const stats = { packages: 0, filesScanned: 0, importsChecked: 0, declarationsChecked: 0 };

  const knownDirs = new Set();
  for (const [key, node] of Object.entries(nodes)) {
    const pkgJsonPath = path.join(repoRoot, node.directory, "package.json");
    if (!fs.existsSync(pkgJsonPath)) {
      issues.push({
        rule: "graph-consistency",
        message: `dependency-graph.json lists "${key}" at ${node.directory}, but no package.json exists there`,
      });
      continue;
    }
    knownDirs.add(path.resolve(repoRoot, node.directory));
  }

  for (const workspaceRoot of WORKSPACE_ROOTS) {
    const absRoot = path.join(repoRoot, workspaceRoot);
    if (!fs.existsSync(absRoot)) continue;
    for (const entry of fs.readdirSync(absRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(absRoot, entry.name);
      if (!fs.existsSync(path.join(dir, "package.json"))) continue;
      if (!knownDirs.has(path.resolve(dir))) {
        issues.push({
          rule: "graph-consistency",
          message: `${workspaceRoot}/${entry.name} contains a package that is not listed in dependency-graph.json; add it to the graph (and dependency-graph.md) or remove the package`,
        });
      }
    }
  }

  for (const [key, node] of Object.entries(nodes)) {
    if (fs.existsSync(path.join(repoRoot, node.directory, "package.json"))) {
      stats.packages++;
      analyzePackage(key, node, graph, repoRoot, issues, stats);
    }
  }

  return { issues, stats };
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { issues, stats } = validateRepository(repoRoot);

  if (issues.length > 0) {
    console.error(`architecture:check FAILED — ${issues.length} issue(s)\n`);
    for (const issue of issues) {
      console.error(`  [${issue.rule}] ${issue.message}`);
    }
    console.error(
      `\nChecked ${stats.packages} packages, ${stats.filesScanned} files, ` +
        `${stats.importsChecked} imports, ${stats.declarationsChecked} internal declarations.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `architecture:check OK — ${stats.packages} packages, ${stats.filesScanned} files, ` +
      `${stats.importsChecked} imports, ${stats.declarationsChecked} internal declarations; ` +
      `all agree with docs/architecture/dependency-graph.json`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
