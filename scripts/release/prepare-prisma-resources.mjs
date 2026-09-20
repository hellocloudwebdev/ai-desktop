// scripts/release/prepare-prisma-resources.mjs
// Copies generated .prisma and @prisma client assets into apps/desktop/build/prisma
// so electron-builder includes them in extraResources/node_modules for the production desktop app.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

try {
  const prismaPkgPath = path.dirname(require.resolve("@prisma/client/package.json"));
  const dotPrismaPath = path.resolve(prismaPkgPath, "../../.prisma");
  const atPrismaPath = path.resolve(prismaPkgPath, "..");

  const targetNodeModules = path.resolve("apps/desktop/build/prisma/node_modules");
  fs.mkdirSync(path.join(targetNodeModules, ".prisma"), { recursive: true });
  fs.mkdirSync(path.join(targetNodeModules, "@prisma"), { recursive: true });

  if (fs.existsSync(dotPrismaPath)) {
    fs.cpSync(dotPrismaPath, path.join(targetNodeModules, ".prisma"), { recursive: true });
    console.log(`[prepare-prisma] Copied .prisma from ${dotPrismaPath}`);
  } else {
    console.warn(`[prepare-prisma] Warning: .prisma not found at ${dotPrismaPath}`);
  }

  if (fs.existsSync(atPrismaPath)) {
    fs.cpSync(atPrismaPath, path.join(targetNodeModules, "@prisma"), { recursive: true });
    console.log(`[prepare-prisma] Copied @prisma from ${atPrismaPath}`);
  } else {
    console.warn(`[prepare-prisma] Warning: @prisma not found at ${atPrismaPath}`);
  }

  console.log("[prepare-prisma] Successfully prepared prisma runtime resources.");
} catch (error) {
  console.error("[prepare-prisma] Failed to prepare prisma resources:", error);
  process.exit(1);
}
