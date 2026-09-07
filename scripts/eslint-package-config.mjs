// PR2 — Per-package ESLint boundary configuration, generated from the locked
// dependency graph (docs/architecture/dependency-graph.json).
//
// Each workspace package's eslint.config.mjs is a two-liner:
//
//   import { definePackageConfig } from "../../scripts/eslint-package-config.mjs";
//   export default definePackageConfig(import.meta.url);
//
// The factory identifies the package from its own config file's URL (never from
// the cwd) and pins "boundaries/root-path" to the repository root, so element
// patterns are repo-relative and every per-package `eslint .` run classifies
// identically no matter where it is invoked from.
//
// Enforcement model (see the plugin's classification docs):
//   - Files match elements via "packages/<pkg>/src/**" patterns.
//   - Relative imports that resolve to another package's files are checked as
//     element-to-element edges.
//   - Bare "@ai-desktop/*" specifiers classify as external modules with the
//     package name as source (whether resolved through node_modules or
//     unresolvable), so the same locked edges are enforced for them via
//     module-source policies.
//   - node builtins (core) and third-party packages (external) are allowed
//     here; third-party *declaration* is enforced by
//     scripts/validate-dependencies.mjs (`pnpm architecture:check`).
//   - electron is disallowed for every element except the desktop application.
//
// Policies use the plugin's last-match-wins semantics: broad allows first,
// then disallows, then the specific edge/self/electron allows that must win.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadGraph() {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "docs", "architecture", "dependency-graph.json"), "utf8"),
  );
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

export function definePackageConfig(configFileUrl) {
  const graph = loadGraph();
  const scope = graph.scope;
  const nodes = { ...graph.packages, ...graph.applications };

  const pkgDir = path.dirname(fileURLToPath(configFileUrl));
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const selfKey = pkgJson.name.startsWith(`${scope}/`)
    ? pkgJson.name.slice(scope.length + 1)
    : null;
  if (!selfKey || !nodes[selfKey]) {
    throw new Error(
      `eslint-package-config: ${pkgJson.name} is not defined in docs/architecture/dependency-graph.json`,
    );
  }

  const elements = Object.entries(nodes).map(([key, node]) => ({
    type: key,
    pattern: `${toPosix(node.directory)}/src/**`,
  }));

  const edges = Object.entries(nodes).flatMap(([key, node]) =>
    (node.internalDependencies ?? []).map((dep) => [key, dep]),
  );

  const policies = [
    { allow: { to: { module: { origin: "core" } } } },
    { allow: { to: { module: { origin: "external" } } } },
    { disallow: { to: { module: { origin: "external", source: `${scope}/*` } } } },
    { disallow: { to: { module: { origin: "external", source: "electron" } } } },
    {
      from: { element: { type: "desktop" } },
      allow: { to: { module: { origin: "external", source: "electron" } } },
    },
    ...Object.keys(nodes).flatMap((key) => [
      { from: { element: { type: key } }, allow: { to: { element: { type: key } } } },
      {
        from: { element: { type: key } },
        allow: { to: { module: { origin: "external", source: `${scope}/${key}` } } },
      },
    ]),
    ...edges.flatMap(([from, to]) => [
      { from: { element: { type: from } }, allow: { to: { element: { type: to } } } },
      {
        from: { element: { type: from } },
        allow: { to: { module: { origin: "external", source: `${scope}/${to}` } } },
      },
    ]),
  ];

  return tseslint.config(
    {
      ignores: ["node_modules/**", "dist/**", "dist-electron/**", "coverage/**", ".turbo/**"],
    },
    ...tseslint.configs.recommended,
    {
      plugins: { boundaries },
      settings: {
        "boundaries/root-path": REPO_ROOT,
        "boundaries/elements": elements,
        "boundaries/ignore": ["**/eslint.config.*"],
      },
      rules: {
        "boundaries/dependencies": [
          "error",
          {
            default: "disallow",
            // Without this the rule only evaluates dependencies whose target is a
            // local file, silently skipping bare specifiers ("electron",
            // "@ai-desktop/*") — the imports this enforcement exists for.
            checkAllOrigins: true,
            policies,
          },
        ],
      },
    },
  );
}
