import { defineConfig } from "vitest/config";

// Root-level tests cover repository tooling (the PR2 dependency validator).
// Workspace packages run their own tests through Turbo as they gain them.
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.mjs"],
  },
});
