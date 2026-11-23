import { afterAll, describe, expect, it } from "vitest";
import {
  AnalysisError,
  createDefaultRegistry,
  createExtractionPool,
  type ExtractionPool,
  type ExtractPoolSettings,
  locateWorkerEntry,
  sharedPoolStats,
  shutdownSharedPool,
} from "../src/index.ts";
import {
  analyzeDir,
  makeTempRepo,
  POLYGLOT_FIXTURE_REPO,
  PY_FIXTURE_REPO,
  withoutTimings,
} from "./support.ts";

// These tests start real worker threads that run the real Python plugin on tree-sitter.
const plugins = [...createDefaultRegistry().plugins];
const entry = locateWorkerEntry();
if (entry === undefined) throw new Error("worker entry not found");

const pools: ExtractionPool[] = [];
afterAll(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
  await shutdownSharedPool();
});

/** Settings that use a private pool (closed after the tests) and start threads for tiny repos. */
function privatePool(maxWorkers: number, recycleAfterJobs?: number): ExtractPoolSettings {
  const pool = createExtractionPool({
    maxWorkers,
    entry: entry as NonNullable<typeof entry>,
    recycleAfterJobs,
  });
  pools.push(pool);
  return {
    workers: maxWorkers,
    filesPerWorker: 1,
    acquirePool: () => ({ pool, release: () => undefined }),
  };
}

function pythonFiles(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const other = (i * 7 + 1) % count;
    files[`pkg/mod${i}.py`] = [
      `from pkg.mod${other} import Thing${other}`,
      "",
      `class Thing${i}:`,
      "    def run(self, value):",
      `        return Thing${other}().run(value) + helper${i}(value)`,
      "",
      `def helper${i}(value):`,
      "    return value + 1",
      "",
    ].join("\n");
  }
  files["pkg/__init__.py"] = "";
  return files;
}

describe("worker pool: identical results with 1 or N workers", () => {
  it("python fixture: 2 real worker threads give the same graph as the main thread", async () => {
    const single = await analyzeDir(PY_FIXTURE_REPO, plugins);
    const settings = privatePool(2);
    const pooled = await analyzeDir(PY_FIXTURE_REPO, plugins, { extractPool: settings });
    expect(withoutTimings(pooled)).toEqual(withoutTimings(single));
    expect(JSON.stringify(pooled.nodes)).toBe(JSON.stringify(single.nodes));
    expect(JSON.stringify(pooled.edges)).toBe(JSON.stringify(single.edges));
    expect(pooled.stats.pluginErrors).toEqual([]);
    expect(pooled.stats.parseErrorFiles).toBe(1);
  }, 120_000);

  it("polyglot fixture (TypeScript stays on the main thread, Python goes to workers)", async () => {
    const single = await analyzeDir(POLYGLOT_FIXTURE_REPO, plugins);
    const pooled = await analyzeDir(POLYGLOT_FIXTURE_REPO, plugins, {
      extractPool: privatePool(3),
    });
    expect(withoutTimings(pooled)).toEqual(withoutTimings(single));
  }, 120_000);

  it("uses the shared pool by default and the files/50 rule keeps small repos single-threaded", async () => {
    await shutdownSharedPool();
    const small = await analyzeDir(PY_FIXTURE_REPO, plugins, { extractPool: { workers: 4 } });
    expect(small.stats.pluginErrors).toEqual([]);
    expect(sharedPoolStats()).toBeUndefined(); // 11 files / 50 < 2: no pool was created

    const { dir, cleanup } = await makeTempRepo(pythonFiles(130) /* + __init__.py = 131 */);
    try {
      const single = await analyzeDir(dir, plugins);
      const pooled = await analyzeDir(dir, plugins, { extractPool: { workers: 2 } });
      expect(withoutTimings(pooled)).toEqual(withoutTimings(single));
      const stats = sharedPoolStats();
      expect(stats?.spawned).toBe(2);
      expect(stats?.completed).toBe(131);
    } finally {
      await cleanup();
      await shutdownSharedPool();
    }
  }, 120_000);

  it("falls back to the main thread when the workers cannot start", async () => {
    const broken = createExtractionPool({
      maxWorkers: 2,
      entry: {
        url: new URL("../src/pipeline/workers/test-support/broken-start-entry.ts", import.meta.url),
        execArgv: entry.execArgv,
      },
    });
    pools.push(broken);
    const single = await analyzeDir(PY_FIXTURE_REPO, plugins);
    const pooled = await analyzeDir(PY_FIXTURE_REPO, plugins, {
      extractPool: {
        workers: 2,
        filesPerWorker: 1,
        acquirePool: () => ({ pool: broken, release: () => undefined }),
      },
    });
    expect(pooled.nodes).toEqual(single.nodes);
    expect(pooled.edges).toEqual(single.edges);
    expect(pooled.stats.pluginErrors.map((e) => e.stage)).toEqual(["pool"]);
  }, 120_000);
});

describe("worker pool: cancellation", () => {
  it("stops an analysis that is aborted while workers are busy", async () => {
    const { dir, cleanup } = await makeTempRepo(pythonFiles(400));
    const controller = new AbortController();
    try {
      let error: unknown;
      await analyzeDir(dir, plugins, {
        extractPool: privatePool(2),
        signal: controller.signal,
        onProgress: (event) => {
          if (event.phase === "parsing" && event.filesDone > 20) controller.abort();
        },
      }).catch((err: unknown) => {
        error = err;
      });
      expect(error).toBeInstanceOf(AnalysisError);
      expect((error as AnalysisError).code).toBe("CANCELLED");
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe("worker pool: memory", () => {
  it("handles 3,000 small files through 2 workers without unbounded growth", async () => {
    const { dir, cleanup } = await makeTempRepo(pythonFiles(1500));
    try {
      const settings = privatePool(2);
      const rssMb = () => process.memoryUsage().rss / 1024 / 1024;
      let afterFirst = 0;
      let afterSecond = 0;
      for (let round = 0; round < 2; round++) {
        const result = await analyzeDir(dir, plugins, { extractPool: settings });
        expect(result.stats.pluginErrors).toEqual([]);
        expect(result.stats.parseErrorFiles).toBe(0);
        if (round === 0) afterFirst = rssMb();
        else afterSecond = rssMb();
      }
      // The second round of 1,500 files must not grow the main process like the first did.
      expect(afterSecond - afterFirst).toBeLessThan(250);
      const pool = pools[pools.length - 1];
      expect(pool?.stats().completed).toBe(3002);
      expect(pool?.stats().replaced).toBe(0);
    } finally {
      await cleanup();
    }
  }, 300_000);
});
