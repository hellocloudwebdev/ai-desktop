// Tests for scripts/validate-dependencies.mjs — the PR2 dependency validator.
// Matrix per the PR2 specification (Step 25.16): valid edges pass; forbidden
// edges, undeclared imports, relative escapes, and Electron violations fail;
// the graph and the workspace must agree.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractImports, validateRepository } from "./validate-dependencies.mjs";

const GRAPH = {
  scope: "@ai-desktop",
  packages: {
    shared: { directory: "packages/shared", internalDependencies: [] },
    "ai-core": { directory: "packages/ai-core", internalDependencies: ["shared"] },
    providers: { directory: "packages/providers", internalDependencies: ["ai-core", "shared"] },
    storage: { directory: "packages/storage", internalDependencies: ["ai-core", "shared"] },
    permissions: {
      directory: "packages/permissions",
      internalDependencies: ["ai-core", "storage", "shared"],
    },
  },
  applications: {
    desktop: { directory: "apps/desktop", internalDependencies: ["agent-runtime"] },
  },
  external: { electron: { allowedIn: ["desktop"] } },
};

const roots = [];

function makeRepo({ graph = GRAPH, packages = {}, applications = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-arch-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "docs", "architecture"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs", "architecture", "dependency-graph.json"),
    JSON.stringify(graph),
  );

  const nodes = { ...graph.packages, ...graph.applications };
  const overrides = { ...packages, ...applications };
  for (const key of Object.keys(nodes)) {
    const override = overrides[key] ?? {};
    const json = { name: `@ai-desktop/${key}`, private: true, type: "module", ...override.json };
    const dir = path.join(root, nodes[key].directory);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(json));
    for (const [file, content] of Object.entries(override.files ?? {})) {
      const filePath = path.join(dir, file);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
  }
  return root;
}

function issuesOf(root) {
  return validateRepository(root).issues;
}

function rulesOf(root) {
  return issuesOf(root).map((issue) => issue.rule);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("valid dependency edges", () => {
  it("accepts ai-core -> shared and providers -> ai-core/shared when declared and imported", () => {
    const root = makeRepo({
      packages: {
        "ai-core": {
          json: { dependencies: { "@ai-desktop/shared": "workspace:*" } },
          files: { "src/index.ts": `import { x } from "@ai-desktop/shared";\nexport { x };\n` },
        },
        providers: {
          json: {
            dependencies: {
              "@ai-desktop/ai-core": "workspace:*",
              "@ai-desktop/shared": "workspace:*",
            },
          },
          files: {
            "src/index.ts": `import { y } from "@ai-desktop/ai-core";\nimport { z } from "@ai-desktop/shared";\nexport { y, z };\n`,
          },
        },
      },
    });
    expect(issuesOf(root)).toEqual([]);
  });

  it("accepts relative imports that stay inside the package and node builtins anywhere", () => {
    const root = makeRepo({
      packages: {
        shared: {
          files: {
            "src/index.ts": `import { join } from "node:path";\nimport helper from "./helper.js";\nexport { helper };\n`,
            "src/helper.ts": `export default 1;\n`,
          },
        },
      },
    });
    expect(issuesOf(root)).toEqual([]);
  });

  it("accepts self-imports by package name", () => {
    const root = makeRepo({
      packages: {
        shared: {
          files: {
            "src/index.ts": `import { a } from "@ai-desktop/shared/inner";\nexport { a };\n`,
          },
        },
      },
    });
    expect(issuesOf(root)).toEqual([]);
  });
});

describe("forbidden architecture edges", () => {
  const cases = [
    ["shared", "ai-core"],
    ["ai-core", "providers"],
    ["storage", "providers"],
  ];

  for (const [from, to] of cases) {
    it(`rejects ${from} -> ${to}`, () => {
      const root = makeRepo({
        packages: {
          [from]: {
            json: { dependencies: { [`@ai-desktop/${to}`]: "workspace:*" } },
            files: { "src/index.ts": `import { x } from "@ai-desktop/${to}";\nexport { x };\n` },
          },
        },
      });
      expect(rulesOf(root)).toContain("forbidden-edge");
    });
  }

  it("rejects a declared dependency that violates the graph even without imports", () => {
    const root = makeRepo({
      packages: {
        shared: { json: { devDependencies: { "@ai-desktop/ai-core": "workspace:*" } } },
      },
    });
    expect(rulesOf(root)).toContain("forbidden-edge");
  });
});

describe("dependency declaration", () => {
  it("rejects an undeclared internal import", () => {
    const root = makeRepo({
      packages: {
        providers: {
          files: { "src/index.ts": `import { x } from "@ai-desktop/shared";\nexport { x };\n` },
        },
      },
    });
    expect(rulesOf(root)).toContain("undeclared-dependency");
  });

  it("rejects an undeclared third-party import", () => {
    const root = makeRepo({
      packages: {
        providers: { files: { "src/index.ts": `import { z } from "zod";\nexport { z };\n` } },
      },
    });
    expect(rulesOf(root)).toContain("undeclared-dependency");
  });

  it("rejects internal dependencies that do not use the workspace: protocol", () => {
    const root = makeRepo({
      packages: {
        "ai-core": { json: { dependencies: { "@ai-desktop/shared": "^0.0.0" } } },
      },
    });
    expect(rulesOf(root)).toContain("workspace-protocol");
  });
});

describe("relative package escapes", () => {
  it("rejects a relative import crossing into another package", () => {
    const root = makeRepo({
      packages: {
        "ai-core": {
          json: { dependencies: { "@ai-desktop/shared": "workspace:*" } },
          files: { "src/index.ts": `export * from "../../shared/src/index";\n` },
        },
      },
    });
    expect(rulesOf(root)).toContain("relative-escape");
  });
});

describe("electron boundary", () => {
  it("rejects an electron import inside packages/", () => {
    const root = makeRepo({
      packages: {
        shared: { files: { "src/index.ts": `import { app } from "electron";\nexport { app };\n` } },
      },
    });
    expect(rulesOf(root)).toContain("electron-boundary");
  });

  it("rejects a declared electron dependency outside apps/desktop", () => {
    const root = makeRepo({
      packages: { shared: { json: { devDependencies: { electron: "44.0.0" } } } },
    });
    expect(rulesOf(root)).toContain("electron-boundary");
  });

  it("permits electron in the desktop application", () => {
    const root = makeRepo({
      applications: {
        desktop: {
          json: { devDependencies: { electron: "44.0.0" } },
          files: { "src/main.ts": `import { app } from "electron";\nexport { app };\n` },
        },
      },
    });
    expect(issuesOf(root)).toEqual([]);
  });
});

describe("graph consistency", () => {
  it("rejects a package on disk that is missing from the graph", () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, "packages", "rogue"));
    fs.writeFileSync(
      path.join(root, "packages", "rogue", "package.json"),
      JSON.stringify({ name: "@ai-desktop/rogue" }),
    );
    expect(rulesOf(root)).toContain("graph-consistency");
  });

  it("rejects a graph entry without a package on disk", () => {
    const root = makeRepo();
    fs.rmSync(path.join(root, "packages", "shared"), { recursive: true });
    expect(rulesOf(root)).toContain("graph-consistency");
  });

  it("rejects a package.json name that does not match the graph", () => {
    const root = makeRepo();
    fs.writeFileSync(
      path.join(root, "packages", "shared", "package.json"),
      JSON.stringify({ name: "@ai-desktop/not-shared" }),
    );
    expect(rulesOf(root)).toContain("graph-consistency");
  });

  it("rejects an import of an internal name that is not in the graph", () => {
    const root = makeRepo({
      packages: {
        shared: {
          files: { "src/index.ts": `import { x } from "@ai-desktop/ghost";\nexport { x };\n` },
        },
      },
    });
    expect(rulesOf(root)).toContain("unknown-internal-package");
  });
});

describe("import extraction", () => {
  it("finds static, type, export-from, side-effect, dynamic, and require imports with line numbers", () => {
    const content = [
      `import { a } from "@ai-desktop/shared";`,
      `import type { B } from "types-only";`,
      ``,
      `export { c } from "@ai-desktop/shared";`,
      `import "side-effect";`,
      `const d = await import("dynamic-pkg");`,
      `const e = require("legacy-pkg");`,
      `const text = 'import { fake } from "not-a-real-import";'`,
    ].join("\n");

    const specifiers = extractImports(content).map((entry) => entry.specifier);
    expect(specifiers).toEqual([
      "@ai-desktop/shared",
      "types-only",
      "@ai-desktop/shared",
      "side-effect",
      "dynamic-pkg",
      "legacy-pkg",
    ]);

    const dynamic = extractImports(content).find((entry) => entry.specifier === "dynamic-pkg");
    expect(dynamic.line).toBe(6);
  });
});
