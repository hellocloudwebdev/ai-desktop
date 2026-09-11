import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ai-desktop/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@ai-desktop/ai-core": path.resolve(__dirname, "../../packages/ai-core/src/index.ts"),
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 20000,
  },
});
