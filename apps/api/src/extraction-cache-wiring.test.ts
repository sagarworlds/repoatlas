import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultRegistry, LocalDirFetcher, MemoryExtractionCache } from "@repoatlas/core";
import { openStore } from "@repoatlas/store";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { buildServer } from "./server.ts";

const PY_FIXTURE = fileURLToPath(new URL("../../../fixtures/python/repo", import.meta.url));

describe("extraction cache wiring", () => {
  it("passes the injected cache to the analysis jobs", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ra-api-cache-"));
    const store = openStore(":memory:");
    const cache = new MemoryExtractionCache();
    const config = parseConfig({ LOG_LEVEL: "silent", DATA_DIR: dataDir }, dataDir);
    const { app, jobs } = await buildServer({
      config,
      store,
      fetcher: new LocalDirFetcher({ dir: PY_FIXTURE }),
      plugins: [...createDefaultRegistry().plugins],
      extractionCache: cache,
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "POST",
        url: "/api/analyses",
        payload: { repoUrl: "https://github.com/acme/fixture" },
      });
      expect(res.statusCode).toBe(202);
      await jobs.idle();
      const id = (res.json() as { id: string }).id;
      const record = store.getAnalysis(id);
      expect(record?.status).toBe("done");
      expect(record?.stats?.cache?.misses).toBeGreaterThan(0);
      expect(cache.size).toBeGreaterThan(0);
    } finally {
      await jobs.shutdown(1000);
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
