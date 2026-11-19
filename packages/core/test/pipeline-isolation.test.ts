import type { SourceFile } from "@repoatlas/plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisError, DEFAULT_LIMITS } from "../src/index.ts";
import {
  analyzeDir,
  callEdge,
  emptyResolution,
  fakePlugin,
  makeTempRepo,
  simpleExtraction,
} from "./support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempRepo(files: Record<string, string>): Promise<string> {
  const repo = await makeTempRepo(files);
  cleanups.push(repo.cleanup);
  return repo.dir;
}

const THREE_FILES = { "a.py": "x = 1\n", "b.py": "y = 2\n", "c.py": "z = 3\n" };

describe("NO_SUPPORTED_LANGUAGES", () => {
  it("is thrown when no plugin claims a file", async () => {
    const dir = await tempRepo({ "notes.txt": "hello\n", "docs/readme.txt": "world\n" });
    await expect(analyzeDir(dir, [fakePlugin()])).rejects.toMatchObject({
      code: "NO_SUPPORTED_LANGUAGES",
    });
  });

  it("is thrown when every claimed file is minified", async () => {
    const dir = await tempRepo({ "a.py": `${"x=1;".repeat(2000)}\n` });
    const error = await analyzeDir(dir, [fakePlugin()]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnalysisError);
    expect((error as AnalysisError).code).toBe("NO_SUPPORTED_LANGUAGES");
  });
});

describe("error isolation", () => {
  it("skips a file whose extract throws and keeps the others", async () => {
    const dir = await tempRepo(THREE_FILES);
    const plugin = fakePlugin({
      extract: async (file: SourceFile) => {
        if (file.path === "b.py") throw new Error("boom");
        return simpleExtraction(file);
      },
    });
    const result = await analyzeDir(dir, [plugin]);
    expect(result.nodes.some((n) => n.id === "sym:a.py#f")).toBe(true);
    expect(result.nodes.some((n) => n.id === "sym:c.py#f")).toBe(true);
    expect(result.nodes.some((n) => n.file === "b.py")).toBe(false);
    expect(result.stats.skippedFiles).toContainEqual({ reason: "extract-error", count: 1 });
    expect(result.stats.languages.python?.files).toBe(2);
  });

  it("skips and counts extractions that fail schema validation", async () => {
    const dir = await tempRepo(THREE_FILES);
    const plugin = fakePlugin({
      extract: async (file: SourceFile) => {
        const good = simpleExtraction(file);
        if (file.path === "a.py") return { ...good, parseErrors: -5 };
        if (file.path === "b.py") return { ...good, file: "somewhere/else.py" };
        return good;
      },
    });
    const result = await analyzeDir(dir, [plugin]);
    expect(result.stats.skippedFiles).toContainEqual({ reason: "invalid-extraction", count: 2 });
    expect(result.nodes.filter((n) => n.kind === "function").map((n) => n.file)).toEqual(["c.py"]);
  });

  it("keeps definitions when a plugin's resolve throws, and records the error", async () => {
    const dir = await tempRepo(THREE_FILES);
    const plugin = fakePlugin({
      resolve: async () => {
        throw new Error("resolve failed");
      },
    });
    const result = await analyzeDir(dir, [plugin]);
    expect(result.nodes.filter((n) => n.kind === "function")).toHaveLength(3);
    expect(result.stats.pluginErrors).toEqual([
      { plugin: "fake", stage: "resolve", message: "resolve failed" },
    ]);
    expect(result.edges.every((e) => e.kind === "contains")).toBe(true);
  });

  it("continues with empty info when prepare throws", async () => {
    const dir = await tempRepo(THREE_FILES);
    const plugin = {
      ...fakePlugin(),
      prepare: async () => {
        throw new Error("prepare failed");
      },
    };
    const result = await analyzeDir(dir, [plugin]);
    expect(result.stats.pluginErrors).toEqual([
      { plugin: "fake", stage: "prepare", message: "prepare failed" },
    ]);
    expect(result.nodes.filter((n) => n.kind === "function")).toHaveLength(3);
  });

  it("falls back to per-file extraction when analyzeProject throws", async () => {
    const dir = await tempRepo(THREE_FILES);
    const plugin = fakePlugin({
      tier: 3,
      analyzeProject: async () => {
        throw new Error("program crashed");
      },
    });
    const result = await analyzeDir(dir, [plugin]);
    expect(result.stats.pluginErrors).toEqual([
      { plugin: "fake", stage: "analyze", message: "program crashed" },
    ]);
    expect(result.nodes.filter((n) => n.kind === "function")).toHaveLength(3);
    expect(result.edges.every((e) => e.kind === "contains")).toBe(true);
  });

  it("uses analyzeProject output and skips resolve for such plugins", async () => {
    const dir = await tempRepo(THREE_FILES);
    let resolveCalled = false;
    const plugin = fakePlugin({
      tier: 3,
      resolve: async () => {
        resolveCalled = true;
        return emptyResolution();
      },
      analyzeProject: async (ctx) => ({
        extractions: ctx.files.map((f) =>
          simpleExtraction({ ...f, content: "", language: "python" }),
        ),
        resolution: {
          ...emptyResolution(),
          edges: [callEdge("sym:a.py#f", "sym:b.py#f", 3)],
          unresolved: [{ file: "a.py", line: 4, name: "dyn", kind: "call" }],
        },
      }),
    });
    const result = await analyzeDir(dir, [plugin]);
    expect(resolveCalled).toBe(false);
    expect(result.edges.some((e) => e.kind === "calls" && e.dst === "sym:b.py#f")).toBe(true);
    expect(result.stats.references).toEqual({ total: 2, resolved: 1, unresolved: 1 });
    expect(result.unresolved).toEqual([{ file: "a.py", line: 4, name: "dyn", kind: "call" }]);
  });
});

describe("edge validation and merging", () => {
  it("drops edges to missing nodes, plugin contains edges and bad schema edges", async () => {
    const dir = await tempRepo(THREE_FILES);
    const plugin = fakePlugin({
      resolve: async () => ({
        ...emptyResolution(),
        edges: [
          callEdge("sym:a.py#f", "sym:missing.py#nope", 1),
          callEdge("sym:a.py#f", "sym:b.py#f", 2),
          { src: "dir:", dst: "file:a.py", kind: "contains", confidence: "exact" },
          // Invalid per schema (line must be >= 1); passed through `as never` on purpose.
          {
            src: "sym:a.py#f",
            dst: "sym:c.py#f",
            kind: "calls",
            confidence: "exact",
            line: 0,
          } as never,
        ],
      }),
    });
    const result = await analyzeDir(dir, [plugin]);
    expect(result.stats.droppedInvalidEdges).toBe(3);
    expect(result.edges.filter((e) => e.kind === "calls")).toHaveLength(1);
    expect(result.edges.some((e) => e.dst.includes("missing"))).toBe(false);
  });

  it("allows call self-loops (recursion) but never contains self-loops", async () => {
    const dir = await tempRepo(THREE_FILES);
    const plugin = fakePlugin({
      resolve: async () => ({
        ...emptyResolution(),
        edges: [callEdge("sym:a.py#f", "sym:a.py#f", 1)],
      }),
    });
    const result = await analyzeDir(dir, [plugin]);
    expect(result.stats.droppedInvalidEdges).toBe(0);
    expect(result.edges.some((e) => e.kind === "calls" && e.src === e.dst)).toBe(true);
    expect(result.edges.some((e) => e.kind === "contains" && e.src === e.dst)).toBe(false);
  });

  it("merges duplicate edges into one with callCount, lines and best confidence", async () => {
    const dir = await tempRepo(THREE_FILES);
    const plugin = fakePlugin({
      resolve: async () => ({
        ...emptyResolution(),
        edges: [
          callEdge("sym:a.py#f", "sym:b.py#f", 7),
          { ...callEdge("sym:a.py#f", "sym:b.py#f", 3), confidence: "name-match" },
          callEdge("sym:a.py#f", "sym:b.py#f", 9),
        ],
      }),
    });
    const result = await analyzeDir(dir, [plugin]);
    const calls = result.edges.filter((e) => e.kind === "calls");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.meta?.callCount).toBe(3);
    expect(calls[0]?.meta?.lines).toEqual([3, 7, 9]);
    expect(calls[0]?.confidence).toBe("exact");
    const row = result.rollups.find((r) => r.level === "file" && r.kind === "calls");
    expect(row).toMatchObject({ src: "file:a.py", dst: "file:b.py", weight: 3 });
  });

  it("adds external nodes once and ignores invalid or conflicting ones", async () => {
    const dir = await tempRepo(THREE_FILES);
    const ext = { id: "ext:npm:lodash", kind: "external" as const, name: "lodash" };
    const plugin = fakePlugin({
      resolve: async () => ({
        ...emptyResolution(),
        imports: [
          { src: "file:a.py", dst: ext.id, kind: "imports", confidence: "exact" },
          { src: "file:b.py", dst: ext.id, kind: "imports", confidence: "exact" },
        ],
        externals: [ext, ext, { id: "sym:a.py#f", kind: "external", name: "clash" }],
      }),
    });
    const result = await analyzeDir(dir, [plugin]);
    expect(result.nodes.filter((n) => n.id === ext.id)).toHaveLength(1);
    expect(result.nodes.find((n) => n.id === "sym:a.py#f")?.kind).toBe("function");
    expect(result.edges.filter((e) => e.kind === "imports")).toHaveLength(2);
  });

  it("marks the graph truncated when a cap is hit", async () => {
    const dir = await tempRepo(THREE_FILES);
    const { runPipeline, LocalDirFetcher } = await import("../src/index.ts");
    const fetcher = new LocalDirFetcher({ dir });
    const fetched = await fetcher.fetch({ owner: "a", repo: "b" }, dir, DEFAULT_LIMITS);
    const result = await runPipeline({
      fetched,
      plugins: [fakePlugin()],
      limits: DEFAULT_LIMITS,
      caps: { maxNodes: 4 },
    });
    expect(result.nodes).toHaveLength(4);
    expect(result.stats.truncated).toBe(true);
    const ids = new Set(result.nodes.map((n) => n.id));
    expect(result.edges.every((e) => ids.has(e.src) && ids.has(e.dst))).toBe(true);
  });
});

describe("cancellation and limits", () => {
  it("throws CANCELLED when the signal is already aborted", async () => {
    const dir = await tempRepo(THREE_FILES);
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeDir(dir, [fakePlugin()], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("throws CANCELLED when aborted during extraction", async () => {
    const dir = await tempRepo(THREE_FILES);
    const controller = new AbortController();
    const plugin = fakePlugin({
      extract: async (file) => {
        controller.abort();
        return simpleExtraction(file);
      },
    });
    await expect(analyzeDir(dir, [plugin], { signal: controller.signal })).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("throws TIMEOUT when the analysis exceeds analysisTimeoutMs", async () => {
    const dir = await tempRepo(THREE_FILES);
    const plugin = fakePlugin({
      extract: async (file) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return simpleExtraction(file);
      },
    });
    await expect(
      analyzeDir(dir, [plugin], { limits: { ...DEFAULT_LIMITS, analysisTimeoutMs: 10 } }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("does not let a throwing progress callback break the run", async () => {
    const dir = await tempRepo(THREE_FILES);
    const result = await analyzeDir(dir, [fakePlugin()], {
      onProgress: () => {
        throw new Error("listener bug");
      },
    });
    expect(result.nodes.length).toBeGreaterThan(0);
  });
});
