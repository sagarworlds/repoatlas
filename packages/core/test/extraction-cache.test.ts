import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileExtraction } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import {
  createDefaultRegistry,
  type ExtractionCache,
  MemoryExtractionCache,
  NoopExtractionCache,
  type PipelineResult,
} from "../src/index.ts";
import {
  analyzeDir,
  fakePlugin,
  makeTempRepo,
  PY_FIXTURE_REPO,
  simpleExtraction,
} from "./support.ts";

/** Graph output without timings and without the cache counters themselves. */
function graphJson(result: PipelineResult): string {
  const { nodes, edges, rollups, unresolved } = result;
  return JSON.stringify({
    nodes,
    edges,
    rollups,
    unresolved,
    stats: { ...result.stats, timingsMs: {}, cache: undefined },
  });
}

function countingPlugin(calls: string[]) {
  return fakePlugin({
    tier: 1,
    extract: async (file) => {
      calls.push(file.path);
      return simpleExtraction(file);
    },
  });
}

const FILES = {
  "a.py": "def a():\n    pass\n",
  "b.py": "def b():\n    pass\n",
  "c.py": "def c():\n    pass\n",
};

describe("extraction cache in the pipeline (fake Tier 1 plugin)", () => {
  it("hits every file on the second run and extracts nothing", async () => {
    const repo = await makeTempRepo(FILES);
    try {
      const calls: string[] = [];
      const cache = new MemoryExtractionCache();
      const plugins = [countingPlugin(calls)];

      const first = await analyzeDir(repo.dir, plugins, { extractionCache: cache });
      expect(first.stats.cache).toEqual({ hits: 0, misses: 3 });
      expect(calls).toHaveLength(3);

      calls.length = 0;
      const second = await analyzeDir(repo.dir, plugins, { extractionCache: cache });
      expect(second.stats.cache).toEqual({ hits: 3, misses: 0 });
      expect(calls).toHaveLength(0);
      expect(graphJson(second)).toBe(graphJson(first));
      expect(second.stats.timingsMs.cacheLookup).toBeTypeOf("number");
      expect(first.stats.timingsMs.cacheStore).toBeTypeOf("number");
    } finally {
      await repo.cleanup();
    }
  });

  it("touching one file produces exactly one miss", async () => {
    const repo = await makeTempRepo(FILES);
    try {
      const calls: string[] = [];
      const cache = new MemoryExtractionCache();
      const plugins = [countingPlugin(calls)];
      await analyzeDir(repo.dir, plugins, { extractionCache: cache });

      calls.length = 0;
      await appendFile(join(repo.dir, "b.py"), "\n# changed\n");
      const result = await analyzeDir(repo.dir, plugins, { extractionCache: cache });
      expect(result.stats.cache).toEqual({ hits: 2, misses: 1 });
      expect(calls).toEqual(["b.py"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("a plugin version bump invalidates every entry", async () => {
    const repo = await makeTempRepo(FILES);
    try {
      const cache = new MemoryExtractionCache();
      const v1 = fakePlugin({ tier: 1 });
      await analyzeDir(repo.dir, [v1], { extractionCache: cache });
      const v2 = { ...v1, version: "2" };
      const result = await analyzeDir(repo.dir, [v2], { extractionCache: cache });
      expect(result.stats.cache).toEqual({ hits: 0, misses: 3 });
    } finally {
      await repo.cleanup();
    }
  });

  it("produces the same graph without a cache, with a no-op cache and with a warm cache", async () => {
    const repo = await makeTempRepo(FILES);
    try {
      const plugins = [fakePlugin({ tier: 1 })];
      const none = await analyzeDir(repo.dir, plugins);
      const noop = await analyzeDir(repo.dir, plugins, {
        extractionCache: new NoopExtractionCache(),
      });
      const cache = new MemoryExtractionCache();
      await analyzeDir(repo.dir, plugins, { extractionCache: cache });
      const warm = await analyzeDir(repo.dir, plugins, { extractionCache: cache });
      expect(none.stats.cache).toBeUndefined();
      expect(noop.stats.cache).toEqual({ hits: 0, misses: 3 });
      expect(graphJson(noop)).toBe(graphJson(none));
      expect(graphJson(warm)).toBe(graphJson(none));
    } finally {
      await repo.cleanup();
    }
  });

  it("does not cache files with parse errors", async () => {
    const repo = await makeTempRepo({ "a.py": "x", "b.py": "y" });
    try {
      const calls: string[] = [];
      const cache = new MemoryExtractionCache();
      const plugin = fakePlugin({
        tier: 1,
        extract: async (file) => {
          calls.push(file.path);
          const base = simpleExtraction(file);
          return file.path === "b.py" ? { ...base, parseErrors: 1 } : base;
        },
      });
      await analyzeDir(repo.dir, [plugin], { extractionCache: cache });
      calls.length = 0;
      const second = await analyzeDir(repo.dir, [plugin], { extractionCache: cache });
      expect(second.stats.cache).toEqual({ hits: 1, misses: 1 });
      expect(calls).toEqual(["b.py"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("never uses the cache for Tier 3 (whole-project) plugins", async () => {
    const repo = await makeTempRepo(FILES);
    try {
      const cache = new MemoryExtractionCache();
      const plugin = fakePlugin({
        tier: 3,
        analyzeProject: async (ctx) => ({
          extractions: ctx.files.map((f) =>
            simpleExtraction({ ...f, content: "", language: "python" }),
          ),
          resolution: { imports: [], edges: [], externals: [], unresolved: [] },
        }),
      });
      const result = await analyzeDir(repo.dir, [plugin], { extractionCache: cache });
      expect(result.stats.cache).toEqual({ hits: 0, misses: 0 });
      expect(cache.size).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  it("ignores a poisoned entry (wrong file) and a cache that throws", async () => {
    const repo = await makeTempRepo({ "a.py": "x" });
    try {
      const calls: string[] = [];
      const plugins = [countingPlugin(calls)];
      // Learn the real key by running once, then replace the entry with another file's data.
      const probe = new MemoryExtractionCache();
      await analyzeDir(repo.dir, plugins, { extractionCache: probe });
      const poisoned: ExtractionCache = {
        get: () => undefined,
        set: () => {},
        getMany: (keys) => {
          const evil: FileExtraction = { ...simpleExtraction({ path: "other.py" } as never) };
          return new Map(keys.map((k) => [k, evil]));
        },
        setMany: () => {},
        stats: () => new NoopExtractionCache().stats(),
      };
      calls.length = 0;
      const result = await analyzeDir(repo.dir, plugins, { extractionCache: poisoned });
      expect(calls).toEqual(["a.py"]);
      expect(result.stats.cache).toEqual({ hits: 0, misses: 1 });

      const broken: ExtractionCache = {
        ...poisoned,
        getMany: () => {
          throw new Error("disk is gone");
        },
        setMany: () => {
          throw new Error("disk is gone");
        },
      };
      const survived = await analyzeDir(repo.dir, plugins, { extractionCache: broken });
      expect(survived.nodes.some((n) => n.id === "file:a.py")).toBe(true);
      expect(survived.stats.pluginErrors.map((e) => e.stage)).toEqual(["cache"]);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("extraction cache over the python fixture (real Tier 1 plugin)", () => {
  it("gives a byte-identical graph with and without cache; hits equal the cacheable files", async () => {
    const plugins = [...createDefaultRegistry().plugins];
    const without = await analyzeDir(PY_FIXTURE_REPO, plugins);
    const cache = new MemoryExtractionCache();
    const cold = await analyzeDir(PY_FIXTURE_REPO, plugins, { extractionCache: cache });
    const warm = await analyzeDir(PY_FIXTURE_REPO, plugins, { extractionCache: cache });

    const pythonFiles = without.stats.languages.python?.files ?? 0;
    const withParseErrors = without.stats.parseErrorFiles;
    expect(pythonFiles).toBeGreaterThan(0);
    expect(cold.stats.cache).toEqual({ hits: 0, misses: pythonFiles });
    expect(warm.stats.cache).toEqual({
      hits: pythonFiles - withParseErrors,
      misses: withParseErrors,
    });
    expect(graphJson(cold)).toBe(graphJson(without));
    expect(graphJson(warm)).toBe(graphJson(without));
  }, 120_000);
});
