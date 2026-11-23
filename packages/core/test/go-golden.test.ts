import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry, type PipelineResult } from "../src/index.ts";
import { assertGolden, loadExpected } from "./golden-assert.ts";
import { analyzeDir, FIXTURES_DIR, withoutTimings } from "./support.ts";

const GO_REPO = join(FIXTURES_DIR, "go", "repo");
const GO_EXPECTED = join(FIXTURES_DIR, "go", "expected-edges.json");

const plugins = [...createDefaultRegistry().plugins];

function goFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...goFiles(abs));
    else if (entry.name.endsWith(".go")) out.push(abs);
  }
  return out;
}

let result: PipelineResult;

beforeAll(async () => {
  result = await analyzeDir(GO_REPO, plugins);
}, 120_000);

describe("pipeline over the go fixture", () => {
  it("satisfies expected-edges.json", () => {
    assertGolden(loadExpected(GO_EXPECTED), result);
  });

  it("drops no edges and records no plugin errors", () => {
    expect(result.stats.droppedInvalidEdges).toBe(0);
    expect(result.stats.pluginErrors).toEqual([]);
  });

  it("has go reference statistics with a tier 1 plugin", () => {
    const go = result.stats.languages.go;
    expect(go?.pluginTier).toBe(1);
    expect(go?.references?.total).toBeGreaterThan(0);
    expect(go?.references?.resolved).toBeLessThanOrEqual(go?.references?.total ?? 0);
  });

  it("keeps name-match edges rare", () => {
    const { edgesByConfidence: c } = result.stats;
    const total = c.exact + c.inferred + c["name-match"];
    expect(c["name-match"] / total).toBeLessThan(0.2);
  });

  it("has every go file as a file node", () => {
    const files = result.nodes.filter((n) => n.kind === "file");
    expect(files.length).toBe(goFiles(GO_REPO).length);
  });

  it("is deterministic across runs", async () => {
    const again = await analyzeDir(GO_REPO, plugins);
    expect(JSON.stringify(withoutTimings(again))).toBe(JSON.stringify(withoutTimings(result)));
  }, 60_000);
});
