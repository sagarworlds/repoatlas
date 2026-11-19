import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphEdge, GraphNode } from "@repoatlas/schema";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, openStore } from "./index.ts";
import { baseQuery, demoGraph } from "./test-graph.ts";
import type { GraphStore, NewAnalysis } from "./types.ts";

const newAnalysis = (id: string, over: Partial<NewAnalysis> = {}): NewAnalysis => ({
  id,
  owner: "o",
  repo: "r",
  ref: "main",
  analyzerVersion: "1",
  ...over,
});

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ra-store-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let store: GraphStore;
beforeEach(() => {
  store = openStore(":memory:");
});
afterEach(() => store.close());

describe("analyses", () => {
  it("creates a queued analysis and patches it", () => {
    const a = store.createAnalysis(newAnalysis("a1"));
    expect(a.status).toBe("queued");
    expect(a.commitSha).toBeNull();
    expect(Number.isNaN(Date.parse(a.createdAt))).toBe(false);

    store.updateAnalysis("a1", {
      status: "parsing",
      progress: { phase: "parsing", filesDone: 1, filesTotal: 4 },
      commitSha: "abc",
    });
    store.updateAnalysis("a1", { error: "boom" }); // other fields untouched
    const got = store.getAnalysis("a1");
    expect(got?.status).toBe("parsing");
    expect(got?.progress).toEqual({ phase: "parsing", filesDone: 1, filesTotal: 4 });
    expect(got?.commitSha).toBe("abc");
    expect(got?.error).toBe("boom");

    store.updateAnalysis("a1", { progress: null, error: null });
    expect(store.getAnalysis("a1")?.progress).toBeNull();
    expect(store.getAnalysis("a1")?.error).toBeNull();
    expect(store.getAnalysis("missing")).toBeUndefined();
  });

  it("round-trips stats through zod validation", () => {
    store.createAnalysis(newAnalysis("a1"));
    const stats = {
      schemaVersion: 1,
      analyzerVersion: "1",
      commitSha: "abc",
      languages: { typescript: { files: 2, bytes: 10, pluginTier: 1 as const } },
      nodesByKind: { file: 2 },
      edgesByKind: { imports: 1 },
      edgesByConfidence: { exact: 1, inferred: 0, "name-match": 0 },
      references: { total: 1, resolved: 1, unresolved: 0 },
      skippedFiles: [],
      parseErrorFiles: 0,
      droppedInvalidEdges: 0,
      pluginErrors: [],
      timingsMs: { parse: 3 },
    };
    store.updateAnalysis("a1", { stats });
    expect(store.getAnalysis("a1")?.stats).toEqual(stats);
  });

  it("finds cached (done only) and in-flight analyses", () => {
    store.createAnalysis(newAnalysis("a1"));
    store.updateAnalysis("a1", { commitSha: "sha1" });
    expect(store.findCached("o", "r", "sha1", "1")).toBeUndefined(); // not done yet
    expect(store.findInFlight("o", "r", "main")?.id).toBe("a1");

    store.updateAnalysis("a1", { status: "done", finishedAt: new Date().toISOString() });
    expect(store.findCached("o", "r", "sha1", "1")?.id).toBe("a1");
    expect(store.findCached("o", "r", "sha1", "2")).toBeUndefined();
    expect(store.findCached("o", "r", "other", "1")).toBeUndefined();
    expect(store.findInFlight("o", "r", "main")).toBeUndefined();

    store.createAnalysis(newAnalysis("a2", { ref: "dev" }));
    store.updateAnalysis("a2", { status: "failed" });
    expect(store.findInFlight("o", "r", "dev")).toBeUndefined();
  });

  it("lists newest first, unfinished, and evictable (oldest done beyond keep)", () => {
    for (const id of ["a1", "a2", "a3", "a4"]) store.createAnalysis(newAnalysis(id));
    expect(store.listAnalyses(10).map((a) => a.id)).toEqual(["a4", "a3", "a2", "a1"]);
    expect(store.listAnalyses(2).map((a) => a.id)).toEqual(["a4", "a3"]);

    store.updateAnalysis("a1", { status: "done" });
    store.updateAnalysis("a2", { status: "done" });
    store.updateAnalysis("a3", { status: "done" });
    // a4 stays queued: never evictable, but listed as unfinished.
    expect(store.listUnfinished().map((a) => a.id)).toEqual(["a4"]);
    expect(store.listEvictable(1).map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(store.listEvictable(3)).toEqual([]);
    expect(store.listEvictable(0).map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    // Failed analyses count as finished: they must not accumulate forever.
    store.updateAnalysis("a4", { status: "failed" });
    expect(store.listEvictable(1).map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
  });
});

describe("saveGraph / deleteAnalysis", () => {
  it("stores and reads back nodes with all fields", () => {
    store.createAnalysis(newAnalysis("a1"));
    store.saveGraph("a1", demoGraph());
    const node = store.getNode("a1", "sym:src/core/engine.ts#Engine.run");
    expect(node).toMatchObject({
      kind: "method",
      name: "run",
      qualifiedName: "Engine.run",
      span: { startLine: 10, endLine: 15 },
      signature: "Engine.run()",
      parentId: "sym:src/core/engine.ts#Engine",
    });
    expect(store.getNode("a1", "nope")).toBeUndefined();
    expect(store.getNode("other", node?.id ?? "")).toBeUndefined();
    expect(store.getFileNode("a1", "src/util.ts")?.id).toBe("file:src/util.ts");
    expect(store.getFileNode("a1", "src")).toBeUndefined(); // directory, not a file
    expect(store.getFileNode("a1", "nope.ts")).toBeUndefined();
  });

  it("saving twice replaces the previous graph", () => {
    store.createAnalysis(newAnalysis("a1"));
    store.saveGraph("a1", demoGraph());
    store.saveGraph("a1", demoGraph());
    expect(store.search("a1", { q: "helper", limit: 10 })).toHaveLength(1);
  });

  it("rolls back everything when a row is bad", () => {
    store.createAnalysis(newAnalysis("a1"));
    const data = demoGraph();
    const dup = data.nodes[1] as GraphNode;
    const bad = { ...data, nodes: [...data.nodes, dup] }; // primary key violation at the end
    expect(() => store.saveGraph("a1", bad)).toThrow();
    expect(store.getNode("a1", "repo:")).toBeUndefined();
    expect(store.search("a1", { q: "helper", limit: 10 })).toEqual([]);

    const badEdge = { ...data, edges: [...data.edges, { src: undefined } as unknown as GraphEdge] };
    expect(() => store.saveGraph("a1", badEdge)).toThrow();
    expect(store.getNode("a1", "repo:")).toBeUndefined();
    expect(store.getSubgraph("a1", baseQuery({ level: "file" })).nodes).toEqual([]);
  });

  it("a failed re-save keeps the previous graph", () => {
    store.createAnalysis(newAnalysis("a1"));
    store.saveGraph("a1", demoGraph());
    const data = demoGraph();
    const dup = data.nodes[1] as GraphNode;
    expect(() => store.saveGraph("a1", { ...data, nodes: [...data.nodes, dup] })).toThrow();
    expect(store.getNode("a1", "repo:")).toBeDefined();
    expect(store.search("a1", { q: "helper", limit: 10 })).toHaveLength(1);
  });

  it("rejects a graph for an unknown analysis", () => {
    expect(() => store.saveGraph("ghost", demoGraph())).toThrow();
  });

  it("deleteAnalysis removes everything including FTS rows", () => {
    store.createAnalysis(newAnalysis("a1"));
    store.createAnalysis(newAnalysis("a2"));
    store.saveGraph("a1", demoGraph());
    store.saveGraph("a2", demoGraph());
    store.deleteAnalysis("a1");
    expect(store.getAnalysis("a1")).toBeUndefined();
    expect(store.getNode("a1", "repo:")).toBeUndefined();
    expect(store.search("a1", { q: "helper", limit: 5 })).toEqual([]);
    expect(store.search("a2", { q: "helper", limit: 5 })).toHaveLength(1); // other one intact
    store.deleteAnalysis("a1"); // idempotent
  });

  it("deleting the analyses row directly cascades to the child tables", () => {
    withTempDir((dir) => {
      const path = join(dir, "cascade.db");
      const s = openStore(path);
      s.createAnalysis(newAnalysis("a1"));
      s.saveGraph("a1", demoGraph());
      s.close();
      const raw = new Database(path);
      raw.pragma("foreign_keys = ON");
      raw.prepare("DELETE FROM analyses WHERE id = 'a1'").run();
      for (const t of ["nodes", "edges", "rollups", "unresolved"]) {
        expect(raw.prepare(`SELECT count(*) AS c FROM ${t}`).get()).toEqual({ c: 0 });
      }
      raw.close();
    });
  });

  it("saves a 20k node graph quickly", () => {
    store.createAnalysis(newAnalysis("big"));
    const nodes: GraphNode[] = [{ id: "dir:", kind: "directory", name: "root" }];
    const edges: GraphEdge[] = [];
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const id = `sym:f.ts#fn${i}`;
      nodes.push({ id, kind: "function", name: `fn${i}`, parentId: "dir:" });
      edges.push({
        src: id,
        dst: `sym:f.ts#fn${(i + 1) % n}`,
        kind: "calls",
        confidence: "exact",
        line: 1,
      });
      edges.push({
        src: id,
        dst: `sym:f.ts#fn${(i + 7) % n}`,
        kind: "calls",
        confidence: "exact",
        line: 2,
      });
      edges.push({ src: "dir:", dst: id, kind: "contains", confidence: "exact" });
    }
    const start = performance.now();
    store.saveGraph("big", { nodes, edges, rollups: [], unresolved: [] });
    expect(performance.now() - start).toBeLessThan(15_000);
    expect(store.search("big", { q: "fn19999", limit: 5 })).toHaveLength(1);
  });
});

describe("migrations and file databases", () => {
  it("creates parent directories, is idempotent on re-open, and keeps data", () => {
    withTempDir((dir) => {
      const path = join(dir, "nested", "deeper", "atlas.db");
      const first = openStore(path);
      first.createAnalysis(newAnalysis("a1"));
      first.saveGraph("a1", demoGraph());
      first.close();

      const second = openStore(path);
      expect(second.getAnalysis("a1")?.id).toBe("a1");
      expect(second.search("a1", { q: "helper", limit: 5 })).toHaveLength(1);
      second.close();

      const raw = new Database(path);
      expect(raw.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
      raw.close();
    });
  });

  it("refuses a database from a newer build", () => {
    withTempDir((dir) => {
      const path = join(dir, "future.db");
      const raw = new Database(path);
      raw.pragma(`user_version = ${MIGRATIONS.length + 5}`);
      raw.close();
      expect(() => openStore(path)).toThrow(/newer/);
    });
  });
});
