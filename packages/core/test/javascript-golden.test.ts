import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry, type PipelineResult } from "../src/index.ts";
import { assertGolden, loadExpected } from "./golden-assert.ts";
import { analyzeDir, FIXTURES_DIR, withoutTimings } from "./support.ts";

const JS_REPO = join(FIXTURES_DIR, "javascript", "repo");
const JS_EXPECTED = join(FIXTURES_DIR, "javascript", "expected-edges.json");

const plugins = [...createDefaultRegistry().plugins];

let result: PipelineResult;

beforeAll(async () => {
  result = await analyzeDir(JS_REPO, plugins);
}, 120_000);

describe("pipeline over the javascript fixture", () => {
  it("satisfies expected-edges.json", () => {
    assertGolden(loadExpected(JS_EXPECTED), result);
  });

  it("drops no edges and records no plugin errors", () => {
    expect(result.stats.droppedInvalidEdges).toBe(0);
    expect(result.stats.pluginErrors).toEqual([]);
  });

  it("records the language of every file as javascript", () => {
    const files = result.nodes.filter((n) => n.kind === "file");
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(file.language, file.id).toBe("javascript");
    expect(result.stats.languages.javascript?.pluginTier).toBe(3);
    expect(result.stats.languages.typescript).toBeUndefined();
  });

  it("reports exactly one file with parse errors and keeps analysing the others", () => {
    expect(result.stats.parseErrorFiles).toBe(1);
    expect(result.nodes.some((n) => n.id === "sym:src/broken.js#healthy")).toBe(true);
  });

  it("marks the test file but no source file", () => {
    const tests = result.nodes.filter((n) => n.kind === "file" && n.meta?.isTest === true);
    expect(tests.map((n) => n.id)).toEqual(["file:test/user.test.js"]);
  });

  it("creates no call edge into lodash", () => {
    const hit = result.edges.filter((e) => e.dst === "ext:npm:lodash" && e.kind !== "imports");
    expect(hit).toEqual([]);
  });

  it("has reference statistics and few name-match edges", () => {
    const js = result.stats.languages.javascript;
    expect(js?.references?.total).toBeGreaterThan(0);
    expect(js?.references?.resolved).toBeLessThanOrEqual(js?.references?.total ?? 0);
    const { edgesByConfidence: c } = result.stats;
    const total = c.exact + c.inferred + c["name-match"];
    expect(c["name-match"] / total).toBeLessThan(0.2);
  });

  it("is deterministic across runs", async () => {
    const again = await analyzeDir(JS_REPO, plugins);
    expect(JSON.stringify(withoutTimings(again))).toBe(JSON.stringify(withoutTimings(result)));
  }, 60_000);
});
