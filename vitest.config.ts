import { defineConfig } from "vitest/config";

// Each directory under packages/* and apps/* is a Vitest "project" (like a test
// project in a .NET solution). Per-package vitest.config.ts files are optional.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "scripts"],
  },
});
