// Tests for scripts/security-check.mjs — the PR46 production security gate.
// Matrix: each rule passes clean fixtures and fails on violations; string/
// comment awareness avoids false positives; the repo itself stays clean.

import { describe, expect, it } from "vitest";
import {
  checkFile,
  checkRepository,
  extractStringLiterals,
  isForbiddenChannelLiteral,
  stripComments,
  stripStringsAndComments,
} from "./security-check.mjs";

describe("security-check: comment/string awareness", () => {
  it("strips comments but keeps string literals", () => {
    // NOTE: fixtures avoid require("electron")/require("@prisma/client")
    // literals — the gate intentionally matches require() mid-line (mirroring
    // the PR2 validator), so fixtures use a neutral dependency name here.
    const content = `import { x } from "electron"; // from "electron"\n/* require("some-dep") */\n`;
    const stripped = stripComments(content);
    expect(stripped).toContain('from "electron"');
    expect(stripped).not.toContain('require("some-dep")');
  });

  it("strips strings and comments for eval detection", () => {
    const content = `const s = "eval("; // eval(\n/* new Function( */\n`;
    expect(stripStringsAndComments(content)).not.toContain("eval(");
    expect(stripStringsAndComments(content)).not.toContain("new Function(");
  });

  it("extracts quoted literals with line numbers", () => {
    const literals = extractStringLiterals(`const a = "chat:send";\nconst b = 'x';\n`);
    expect(literals.map((entry) => entry.value)).toEqual(["chat:send", "x"]);
    expect(literals[0].line).toBe(1);
  });
});

describe("security-check: forbidden channel segments", () => {
  it("flags execute/eval/spawn segments and ignores lookalikes", () => {
    expect(isForbiddenChannelLiteral("agent:execute")).toBe(true);
    expect(isForbiddenChannelLiteral("tool:eval")).toBe(true);
    expect(isForbiddenChannelLiteral("proc:spawn-now")).toBe(true);
    expect(isForbiddenChannelLiteral("chat:send")).toBe(false);
    expect(isForbiddenChannelLiteral("documents:search")).toBe(false);
    expect(isForbiddenChannelLiteral("retrieval")).toBe(false);
    expect(isForbiddenChannelLiteral("plainstring")).toBe(false);
  });
});

describe("security-check: per-file rules", () => {
  it("rejects electron imports outside apps/desktop", () => {
    const issues = checkFile("packages/shared/src/x.ts", `import { app } from "electron";\n`);
    expect(issues.map((issue) => issue.rule)).toContain("electron-boundary");
    expect(checkFile("apps/desktop/src/main/x.ts", `import { app } from "electron";\n`)).toEqual(
      [],
    );
  });

  it("rejects prisma imports outside packages/storage", () => {
    const issues = checkFile(
      "apps/desktop/src/main/x.ts",
      `import { PrismaClient } from "@prisma/client";\n`,
    );
    expect(issues.map((issue) => issue.rule)).toContain("prisma-boundary");
    expect(
      checkFile("packages/storage/src/x.ts", `import { PrismaClient } from "@prisma/client";\n`),
    ).toEqual([]);
  });

  it("contains child_process to approved boundary files", () => {
    const bad = checkFile("packages/shared/src/x.ts", `import cp from "node:child_process";\n`);
    expect(bad.map((issue) => issue.rule)).toContain("child-process");
    expect(
      checkFile("packages/execution/src/x.ts", `import cp from "node:child_process";\n`),
    ).toEqual([]);
    expect(
      checkFile(
        "apps/desktop/src/main/git/git-cli.ts",
        `import { spawn } from "node:child_process";\n`,
      ),
    ).toEqual([]);
    expect(
      checkFile(
        "apps/desktop/src/main/git/__tests__/x.test.ts",
        `import cp from "node:child_process";\n`,
      ),
    ).toEqual([]);
    // Comments mentioning child_process do not trip the gate.
    expect(checkFile("packages/shared/src/x.ts", `// no child_process here\n`)).toEqual([]);
  });

  it("forbids real eval but ignores string-literal mentions", () => {
    const real = checkFile("apps/desktop/src/main/x.ts", `const f = eval("1+1");\n`);
    expect(real.map((issue) => issue.rule)).toContain("no-eval");
    const ctor = checkFile("apps/desktop/src/main/x.ts", `const f = new Function("return 1");\n`);
    expect(ctor.map((issue) => issue.rule)).toContain("no-eval");
    const mention = checkFile(
      "apps/desktop/src/main/x.ts",
      `expect(src).not.toContain("eval(");\n`,
    );
    expect(mention).toEqual([]);
  });

  it("forbids execute channels in source but allows test assertions", () => {
    const bad = checkFile("apps/desktop/src/main/x.ts", `const c = "agent:execute";\n`);
    expect(bad.map((issue) => issue.rule)).toContain("no-execute-channel");
    const allowed = checkFile(
      "apps/desktop/src/__tests__/x.test.ts",
      `const c = "agent:execute";\n`,
    );
    expect(allowed).toEqual([]);
    expect(checkFile("apps/desktop/src/main/x.ts", `const c = "chat:send";\n`)).toEqual([]);
  });
});

describe("security-check: repository gate", () => {
  it("passes on the real repository", () => {
    const repoRoot = new URL("..", import.meta.url).pathname;
    const { issues } = checkRepository(repoRoot);
    expect(issues).toEqual([]);
  });
});
