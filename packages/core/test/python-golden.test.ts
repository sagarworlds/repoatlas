import { beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry, type PipelineResult } from "../src/index.ts";
import { assertGolden, loadExpected } from "./golden-assert.ts";
import {
  analyzeDir,
  POLYGLOT_EXPECTED,
  POLYGLOT_FIXTURE_REPO,
  PY_EXPECTED,
  PY_FIXTURE_REPO,
  withoutTimings,
} from "./support.ts";

const plugins = [...createDefaultRegistry().plugins];

let python: PipelineResult;
let polyglot: PipelineResult;

beforeAll(async () => {
  python = await analyzeDir(PY_FIXTURE_REPO, plugins);
  polyglot = await analyzeDir(POLYGLOT_FIXTURE_REPO, plugins);
}, 120_000);

describe("pipeline over the python fixture", () => {
  it("satisfies expected-edges.json", () => {
    assertGolden(loadExpected(PY_EXPECTED), python);
  });

  it("drops no edges and records no plugin errors", () => {
    expect(python.stats.droppedInvalidEdges).toBe(0);
    expect(python.stats.pluginErrors).toEqual([]);
  });

  it("reports one file with parse errors and still extracts the symbols before the error", () => {
    expect(python.stats.parseErrorFiles).toBe(1);
    expect(python.nodes.some((n) => n.id === "sym:src/shop/broken.py#healthy")).toBe(true);
  });

  it("marks the test file", () => {
    const node = python.nodes.find((n) => n.id === "file:tests/test_service.py");
    expect(node?.meta?.isTest).toBe(true);
  });

  it("has per-language reference statistics", () => {
    const py = python.stats.languages.python;
    expect(py?.pluginTier).toBe(1);
    expect(py?.references?.total).toBeGreaterThan(0);
    expect(py?.references?.resolved).toBeGreaterThan(0);
    expect(py?.references?.resolved).toBeLessThanOrEqual(py?.references?.total ?? 0);
    expect(python.stats.references.total).toBe(py?.references?.total);
  });

  it("keeps name-match edges rare", () => {
    const { edgesByConfidence: c } = python.stats;
    const total = c.exact + c.inferred + c["name-match"];
    expect(c["name-match"] / total).toBeLessThan(0.2);
  });

  it("is deterministic across runs", async () => {
    const again = await analyzeDir(PY_FIXTURE_REPO, plugins);
    expect(JSON.stringify(withoutTimings(again))).toBe(JSON.stringify(withoutTimings(python)));
  }, 60_000);
});

describe("pipeline over the polyglot fixture", () => {
  it("satisfies expected-edges.json (no cross-language edges)", () => {
    assertGolden(loadExpected(POLYGLOT_EXPECTED), polyglot);
  });

  it("drops no edges and records no plugin errors", () => {
    expect(polyglot.stats.droppedInvalidEdges).toBe(0);
    expect(polyglot.stats.pluginErrors).toEqual([]);
  });

  it("has separate reference statistics per language", () => {
    const languages = polyglot.stats.languages;
    const expectedTiers = [
      ["typescript", 3],
      ["javascript", 3],
      ["python", 1],
      ["go", 1],
      ["java", 1],
    ] as const;
    let sum = 0;
    for (const [language, tier] of expectedTiers) {
      const entry = languages[language];
      expect(entry?.pluginTier, language).toBe(tier);
      expect(entry?.references?.total ?? 0, language).toBeGreaterThan(0);
      sum += entry?.references?.total ?? 0;
    }
    expect(polyglot.stats.references.total).toBe(sum);
  });

  it("analyzes all five languages in one run", () => {
    const fileLanguages = new Set(
      polyglot.nodes.filter((n) => n.kind === "file").map((n) => n.language),
    );
    expect([...fileLanguages].sort()).toEqual(["go", "java", "javascript", "python", "typescript"]);
  });

  it("is deterministic across runs", async () => {
    const again = await analyzeDir(POLYGLOT_FIXTURE_REPO, plugins);
    expect(JSON.stringify(withoutTimings(again))).toBe(JSON.stringify(withoutTimings(polyglot)));
  }, 60_000);
});
