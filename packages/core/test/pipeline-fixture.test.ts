import { beforeAll, describe, expect, it } from "vitest";
import {
  ANALYZER_VERSION,
  analyzeRepository,
  computeRollups,
  createDefaultRegistry,
  DEFAULT_LIMITS,
  LocalDirFetcher,
  type PipelineResult,
  type ProgressEvent,
} from "../src/index.ts";
import { assertGolden, loadExpected } from "./golden-assert.ts";
import {
  analyzeDir,
  countingFetcher,
  makeTempRepo,
  TS_EXPECTED,
  TS_FIXTURE_REPO,
  withoutTimings,
} from "./support.ts";

const plugins = [...createDefaultRegistry().plugins];

let result: PipelineResult;
const events: ProgressEvent[] = [];

beforeAll(async () => {
  result = await analyzeDir(TS_FIXTURE_REPO, plugins, { onProgress: (e) => events.push(e) });
}, 60_000);

describe("pipeline over the typescript fixture", () => {
  it("satisfies expected-edges.json", () => {
    assertGolden(loadExpected(TS_EXPECTED), result);
  });

  it("drops no edges and records no plugin errors", () => {
    expect(result.stats.droppedInvalidEdges).toBe(0);
    expect(result.stats.pluginErrors).toEqual([]);
  });

  it("fills the statistics", () => {
    const { stats } = result;
    expect(stats.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(stats.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(stats.languages.typescript?.pluginTier).toBe(3);
    expect(stats.languages.typescript?.files).toBeGreaterThan(5);
    expect(stats.nodesByKind.repo).toBe(1);
    expect(stats.nodesByKind.file).toBeGreaterThan(5);
    expect(stats.edgesByKind.contains).toBeGreaterThan(10);
    expect(stats.edgesByKind.calls).toBeGreaterThan(5);
    expect(stats.edgesByConfidence.exact).toBeGreaterThan(0);
    expect(stats.references.resolved).toBeGreaterThan(0);
    expect(stats.references.total).toBe(stats.references.resolved + stats.references.unresolved);
    expect(stats.parseErrorFiles).toBe(1);
    expect(stats.truncated).toBeUndefined();
    for (const phase of ["walk", "detect", "read", "extract", "resolve", "rollups", "total"]) {
      expect(stats.timingsMs[phase], phase).toBeGreaterThanOrEqual(0);
    }
  });

  it("builds a consistent tree of contains edges", () => {
    const ids = new Set(result.nodes.map((n) => n.id));
    expect(ids.size).toBe(result.nodes.length);
    const contains = result.edges.filter((e) => e.kind === "contains");
    for (const node of result.nodes) {
      if (node.kind === "repo" || node.kind === "external" || node.kind === "module") continue;
      expect(node.parentId, node.id).toBeDefined();
      expect(
        contains.some((e) => e.src === node.parentId && e.dst === node.id),
        node.id,
      ).toBe(true);
    }
    expect(contains.every((e) => e.confidence === "exact" && e.src !== e.dst)).toBe(true);
    for (const e of result.edges) {
      expect(ids.has(e.src) && ids.has(e.dst), `${e.src} -> ${e.dst}`).toBe(true);
    }
  });

  it("builds symbol nodes with qualified names, spans and loc", () => {
    const save = result.nodes.find((n) => n.id === "sym:src/models/user.ts#User.save");
    expect(save?.qualifiedName).toBe("User.save");
    expect(save?.parentId).toBe("sym:src/models/user.ts#User");
    expect(save?.file).toBe("src/models/user.ts");
    expect(save?.language).toBe("typescript");
    expect(save?.span?.startLine).toBeGreaterThan(0);
    expect(save?.meta?.loc).toBeGreaterThan(0);
  });

  it("propagates isTest to file nodes", () => {
    expect(result.nodes.find((n) => n.id === "file:src/user.test.ts")?.meta?.isTest).toBe(true);
    expect(result.nodes.find((n) => n.id === "file:src/service.ts")?.meta?.isTest).toBeUndefined();
  });

  it("creates file nodes for non-source files that imports point to", () => {
    const importTargets = result.edges.filter((e) => e.kind === "imports").map((e) => e.dst);
    for (const dst of importTargets.filter((d) => d.startsWith("file:"))) {
      expect(
        result.nodes.some((n) => n.id === dst),
        dst,
      ).toBe(true);
    }
  });

  it("merges duplicates: one edge per (src, dst, kind) with callCount", () => {
    const seen = new Set<string>();
    for (const e of result.edges) {
      const key = `${e.kind}|${e.src}|${e.dst}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
    const calls = result.edges.filter((e) => e.kind === "calls");
    expect(calls.every((e) => (e.meta?.callCount ?? 0) >= 1)).toBe(true);
  });

  it("computes rollups that match the final graph", () => {
    expect(result.rollups.length).toBeGreaterThan(0);
    expect(result.rollups).toEqual(computeRollups(result.nodes, result.edges));
    const row = result.rollups.find(
      (r) =>
        r.level === "file" &&
        r.kind === "imports" &&
        r.src === "file:src/service.ts" &&
        r.dst === "file:src/models/user.ts",
    );
    expect(row?.weight).toBe(1);
    const nodeIds = new Set(result.nodes.map((n) => n.id));
    expect(result.rollups.every((r) => nodeIds.has(r.src) && nodeIds.has(r.dst))).toBe(true);
  });

  it("is deterministic across runs", async () => {
    const again = await analyzeDir(TS_FIXTURE_REPO, plugins);
    expect(JSON.stringify(withoutTimings(again))).toBe(JSON.stringify(withoutTimings(result)));
  }, 60_000);

  it("reports monotonic progress", () => {
    expect(events[0]).toEqual({ phase: "fetching", filesDone: 0, filesTotal: 0 });
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("parsing");
    expect(phases).toContain("resolving");
    const order = ["fetching", "parsing", "resolving"];
    const ranks = phases.map((p) => order.indexOf(p));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    for (const phase of ["parsing", "resolving"] as const) {
      const done = events.filter((e) => e.phase === phase).map((e) => e.filesDone);
      expect(done).toEqual([...done].sort((a, b) => a - b));
      const last = events.filter((e) => e.phase === phase).at(-1);
      expect(last?.filesDone).toBe(last?.filesTotal);
    }
  });
});

describe("analyzeRepository", () => {
  it("short-circuits when shouldSkip says the commit is cached", async () => {
    const fetcher = countingFetcher(new LocalDirFetcher({ dir: TS_FIXTURE_REPO }));
    const resolved: { commitSha: string; ref: string }[] = [];
    const out = await analyzeRepository({
      fetcher,
      request: { owner: "acme", repo: "demo" },
      limits: DEFAULT_LIMITS,
      plugins,
      destDirFor: () => {
        throw new Error("destDirFor must not be called");
      },
      shouldSkip: (info) => info.commitSha.length === 40,
      onResolved: (info) => resolved.push(info),
    });
    expect(out.status).toBe("skipped");
    expect(fetcher.resolves).toBe(1);
    expect(fetcher.fetches).toBe(0);
    expect(resolved).toHaveLength(1);
    expect(out).toMatchObject({ commitSha: resolved[0]?.commitSha, ref: "local" });
  });

  it("reports the requested ref and calls destDirFor with the commit", async () => {
    const repo = await makeTempRepo({ "a.ts": "export const a = 1;\n" });
    try {
      let seenSha = "";
      const out = await analyzeRepository({
        fetcher: new LocalDirFetcher({ dir: repo.dir }),
        request: { owner: "acme", repo: "demo", ref: "main" },
        limits: DEFAULT_LIMITS,
        plugins,
        destDirFor: (sha) => {
          seenSha = sha;
          return repo.dir;
        },
      });
      expect(out.status).toBe("analyzed");
      if (out.status === "analyzed") {
        expect(out.fetched.ref).toBe("main");
        expect(out.fetched.commitSha).toBe(seenSha);
        expect(out.result.stats.commitSha).toBe(seenSha);
      }
    } finally {
      await repo.cleanup();
    }
  });
});
