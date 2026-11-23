import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { javaPlugin } from "@repoatlas/lang-java";
import { beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry, type PipelineResult } from "../src/index.ts";
import { assertGolden, loadExpected } from "./golden-assert.ts";
import { analyzeDir, FIXTURES_DIR, withoutTimings } from "./support.ts";

const JAVA_REPO = join(FIXTURES_DIR, "java", "repo");
const JAVA_EXPECTED = join(FIXTURES_DIR, "java", "expected-edges.json");
const plugins = [...createDefaultRegistry().plugins];

function javaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...javaFiles(abs));
    else if (name.endsWith(".java")) out.push(abs);
  }
  return out;
}

describe("pipeline over the java fixture", () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeDir(JAVA_REPO, plugins);
  }, 120_000);

  it("satisfies expected-edges.json", () => {
    assertGolden(loadExpected(JAVA_EXPECTED), result);
  });

  it("drops no edges and records no plugin errors", () => {
    expect(result.stats.droppedInvalidEdges).toBe(0);
    expect(result.stats.pluginErrors).toEqual([]);
  });

  it("has java reference statistics with a tier 1 plugin", () => {
    const java = result.stats.languages.java;
    expect(java?.pluginTier).toBe(1);
    expect(java?.references?.total).toBeGreaterThan(0);
  });

  it("keeps name-match edges rare", () => {
    const { edgesByConfidence: c } = result.stats;
    const total = c.exact + c.inferred + c["name-match"];
    expect(c["name-match"] / total).toBeLessThan(0.2);
  });

  it("has every java file as a file node", () => {
    const files = new Set(result.nodes.filter((n) => n.kind === "file").map((n) => n.id));
    expect(files.size).toBe(javaFiles(JAVA_REPO).length);
  });

  it("is deterministic across runs", async () => {
    const again = await analyzeDir(JAVA_REPO, plugins);
    expect(JSON.stringify(withoutTimings(again))).toBe(JSON.stringify(withoutTimings(result)));
  }, 60_000);
});

describe("java plugin over every fixture file", () => {
  it("never throws and produces unique definition ids", async () => {
    for (const abs of javaFiles(JAVA_REPO)) {
      const content = readFileSync(abs, "utf8");
      const path = relative(JAVA_REPO, abs).split(sep).join("/");
      const ex = await javaPlugin.extract(
        { path, content, language: "java", bytes: Buffer.byteLength(content) },
        {},
      );
      expect(ex?.language).toBe("java");
      const ids = ex?.definitions.map((d) => d.localId) ?? [];
      expect(new Set(ids).size, abs).toBe(ids.length);
    }
  });
});
