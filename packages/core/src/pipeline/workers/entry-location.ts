import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The file the build writes next to server.js (scripts/build-api.ts). */
export const BUNDLED_WORKER_FILE = "extract-worker.js";

/** How to start a worker thread: the file and the Node options it needs. */
export interface WorkerEntry {
  url: URL;
  execArgv: string[];
}

/**
 * Finds the worker entry file for the way this code is running:
 *  - from TypeScript sources (dev with tsx, Vitest): ./worker-entry.ts next to this file,
 *    started with `--import <tsx>` so the worker understands .ts files too;
 *  - from the esbuild bundle: extract-worker.js next to the running server.js.
 * Returns undefined when no usable entry exists; the pipeline then stays single-threaded.
 * `moduleUrl` is the URL of the module that is running (a parameter so tests can pass any).
 */
export function locateWorkerEntry(moduleUrl: string = import.meta.url): WorkerEntry | undefined {
  if (moduleUrl.endsWith(".ts")) {
    const url = new URL("./worker-entry.ts", moduleUrl);
    if (!existsSync(fileURLToPath(url))) return undefined;
    try {
      // tsx is resolved from this file's location, never from the working directory.
      const tsx = pathToFileURL(createRequire(moduleUrl).resolve("tsx")).href;
      return { url, execArgv: ["--import", tsx] };
    } catch {
      return undefined;
    }
  }
  const url = new URL(`./${BUNDLED_WORKER_FILE}`, moduleUrl);
  return existsSync(fileURLToPath(url)) ? { url, execArgv: [] } : undefined;
}
