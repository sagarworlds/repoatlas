// Bundles apps/api/src/index.ts into apps/api/dist/server.js with esbuild, plus the extraction
// worker thread entry into apps/api/dist/extract-worker.js (it must sit next to server.js:
// packages/core/src/pipeline/workers/entry-location.ts looks for it there).
// Run: pnpm exec tsx scripts/build-api.ts
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { API_EXTERNALS } from "./externals.ts";
import { renderEnvDefaultsBanner } from "./grammars.ts";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Some bundled CommonJS packages (fastify, pino, ...) call require() or read __filename.
 * Our output is ESM, where those do not exist, so the banner recreates them.
 * (C# analogy: this is like adding a compatibility shim for an old assembly.)
 */
export const CJS_BANNER = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  'import { dirname as __dirname_ } from "node:path";',
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __dirname_(__filename);",
  renderEnvDefaultsBanner(),
].join("\n");

/** Files esbuild writes into apps/api/dist (each also gets a .map file). */
export const API_OUTPUT_FILES = ["server.js", "extract-worker.js"] as const;

export async function buildApi(root: string = repoRoot): Promise<string> {
  const outdir = path.join(root, "apps", "api", "dist");
  await rm(outdir, { recursive: true, force: true });
  await build({
    // Two self-contained bundles (no code splitting): the key is the output file name.
    entryPoints: {
      server: path.join(root, "apps", "api", "src", "index.ts"),
      "extract-worker": path.join(
        root,
        "packages",
        "core",
        "src",
        "pipeline",
        "workers",
        "worker-entry.ts",
      ),
    },
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    // Native or huge packages stay in node_modules (see scripts/externals.ts).
    external: [...API_EXTERNALS],
    banner: { js: CJS_BANNER },
    logLevel: "info",
  });
  return path.join(outdir, "server.js");
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await buildApi();
}
