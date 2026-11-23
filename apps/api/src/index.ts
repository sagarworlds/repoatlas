import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createDefaultRegistry, GitHubFetcher, shutdownSharedPool } from "@repoatlas/core";
import { openExtractionCache, openStore } from "@repoatlas/store";
import { loadConfig } from "./config.ts";
import { tmpRoot } from "./jobs/storage.ts";
import { buildServer } from "./server.ts";

/** Production entry point. Everything is wired here; tests use buildServer directly. */
const config = loadConfig();

await mkdir(config.dataDir, { recursive: true });
// Temp extraction dirs live under DATA_DIR/tmp (never the system temp dir): clean on boot.
await rm(tmpRoot(config.dataDir), { recursive: true, force: true });
await mkdir(tmpRoot(config.dataDir), { recursive: true });

const store = openStore(path.join(config.dataDir, "repoatlas.db"));
// The extraction cache is an optimization: if it cannot be opened, run without it.
let extractionCache: ReturnType<typeof openExtractionCache> | undefined;
let cacheOpenError: unknown;
try {
  extractionCache = openExtractionCache(path.join(config.dataDir, "repoatlas.db"), {
    maxEntries: config.cacheMaxExtractions,
    maxBytes: config.cacheMaxExtractionBytes,
  });
} catch (err) {
  cacheOpenError = err;
}
const { app, jobs } = await buildServer({
  config,
  store,
  extractionCache,
  fetcher: new GitHubFetcher({ token: config.githubToken }),
  plugins: [...createDefaultRegistry().plugins],
});

if (cacheOpenError !== undefined) {
  app.log.warn({ err: cacheOpenError }, "extraction cache disabled: could not open it");
}

let shuttingDown = false;
async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ reason }, "shutting down");
  // Safety net: never hang longer than a few seconds (blocking parses cannot be aborted).
  setTimeout(() => process.exit(exitCode === 0 ? 1 : exitCode), 8000).unref();
  try {
    await jobs.shutdown(4000); // stop taking jobs, abort running ones (rows stay recoverable)
    await app.close(); // stop accepting HTTP requests
    await shutdownSharedPool(); // end extraction worker threads
    extractionCache?.close();
    store.close();
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    exitCode = exitCode === 0 ? 1 : exitCode;
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown("SIGINT", 0));
process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  app.log.error({ err }, "uncaught exception");
  void shutdown("uncaughtException", 1);
});
if (config.exitOnStdinClose) {
  // HttpPlatformHandler closes our stdin when it stops the process.
  process.stdin.on("end", () => void shutdown("stdin closed", 0));
  process.stdin.on("close", () => void shutdown("stdin closed", 0));
  process.stdin.resume();
}

try {
  await jobs.recover(); // re-queue analyses interrupted by the previous run
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error({ err }, "failed to start");
  store.close();
  process.exit(1);
}
