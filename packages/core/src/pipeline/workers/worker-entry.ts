// Entry file of an extraction worker thread (docs/ARCHITECTURE: extraction pool).
// Dev and Vitest run it from TypeScript through tsx; the API bundle builds it into
// apps/api/dist/extract-worker.js (scripts/build-api.ts).
import { parentPort } from "node:worker_threads";
import { createDefaultRegistry } from "../../plugins/default-registry.ts";
import type { ToWorkerMessage } from "./messages.ts";
import { createWorkerHandler } from "./worker-handler.ts";

const port = parentPort;
if (port === null) throw new Error("worker-entry.ts must run inside a worker thread");

// The worker loads the plugins itself from the default registry (the single source of truth
// for which plugins exist). Plugin objects contain functions, so they cannot be sent over.
const registry = createDefaultRegistry();
const handler = createWorkerHandler((id) => registry.byId(id));

// Messages are handled one at a time so the pool can tell which file a worker is busy with.
let chain: Promise<void> = Promise.resolve();
port.on("message", (message: ToWorkerMessage) => {
  chain = chain.then(async () => {
    const reply = await handler.handle(message);
    if (reply) port.postMessage(reply);
  });
});

port.postMessage({ type: "ready" });
