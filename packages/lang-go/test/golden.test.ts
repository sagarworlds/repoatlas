import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  analyzeRepository,
  DEFAULT_LIMITS,
  LocalDirFetcher,
  type PipelineResult,
} from "../../core/src/index.ts";
import { assertGolden, loadExpected } from "../../core/test/golden-assert.ts";
import { FIXTURES_DIR } from "../../core/test/support.ts";
import { goPlugin } from "../src/index.ts";

const REPO = join(FIXTURES_DIR, "go", "repo");
const EXPECTED = join(FIXTURES_DIR, "go", "expected-edges.json");

let result: PipelineResult;

beforeAll(async () => {
  const out = await analyzeRepository({
    fetcher: new LocalDirFetcher({ dir: REPO, owner: "acme", repo: "demo" }),
    request: { owner: "acme", repo: "demo" },
    limits: DEFAULT_LIMITS,
    plugins: [goPlugin],
    destDirFor: () => REPO,
  });
  if (out.status !== "analyzed") throw new Error("not analyzed");
  result = out.result;
}, 120_000);

describe("go fixture through the pipeline", () => {
  it("satisfies expected-edges.json", () => {
    assertGolden(loadExpected(EXPECTED), result);
  });
  it("has no dropped edges or plugin errors", () => {
    expect(result.stats.droppedInvalidEdges).toBe(0);
    expect(result.stats.pluginErrors).toEqual([]);
  });
});
