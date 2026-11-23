// Bundle smoke test for the extraction worker pool. Built by verify-bundle.ts into a TEMPORARY
// file next to server.js and extract-worker.js (never shipped). It analyzes a generated
// Python + TypeScript directory twice (main thread, then EXTRACT_WORKERS=2 worker threads
// started from the bundled extract-worker.js) and requires identical graphs and a pool that
// really ran. Exit code 0 = ok, 1 = failure. Prints one JSON line.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  analyzeRepository,
  createDefaultRegistry,
  DEFAULT_LIMITS,
  LocalDirFetcher,
  type PipelineResult,
  sharedPoolStats,
  shutdownSharedPool,
} from "../packages/core/src/index.ts";

const PY_FILES = 120;

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "repoatlas-poolsmoke-"));
  await mkdir(path.join(dir, "pkg"), { recursive: true });
  await mkdir(path.join(dir, "web"), { recursive: true });
  await writeFile(path.join(dir, "pkg", "__init__.py"), "");
  for (let i = 0; i < PY_FILES; i++) {
    const other = (i * 7 + 1) % PY_FILES;
    const lines = [
      `from pkg.mod${other} import Thing${other}`,
      "",
      `class Thing${i}:`,
      "    def run(self, value):",
      `        return Thing${other}().run(value) + helper${i}(value)`,
      "",
      `def helper${i}(value):`,
      "    return value + 1",
      "",
    ];
    await writeFile(path.join(dir, "pkg", `mod${i}.py`), lines.join("\n"));
  }
  for (let i = 0; i < 5; i++) {
    const src = [
      i > 0 ? `import { f${i - 1} } from "./m${i - 1}";` : "",
      `export function f${i}(): number {`,
      i > 0 ? `  return f${i - 1}() + 1;` : "  return 1;",
      "}",
      "",
    ];
    await writeFile(path.join(dir, "web", `m${i}.ts`), src.join("\n"));
  }
  return dir;
}

async function analyze(dir: string, workers: number | undefined): Promise<PipelineResult> {
  const out = await analyzeRepository({
    fetcher: new LocalDirFetcher({ dir, owner: "smoke", repo: "pool" }),
    request: { owner: "smoke", repo: "pool" },
    limits: DEFAULT_LIMITS,
    plugins: [...createDefaultRegistry().plugins],
    destDirFor: () => dir,
    extractPool: workers === undefined ? undefined : { workers },
  });
  if (out.status !== "analyzed") throw new Error("analysis was skipped");
  return out.result;
}

let dir: string | undefined;
try {
  dir = await makeRepo();
  const configured = Number(process.env.EXTRACT_WORKERS ?? "2");
  const single = await analyze(dir, undefined);
  const pooled = await analyze(dir, configured);
  const stats = sharedPoolStats();
  const same =
    JSON.stringify(single.nodes) === JSON.stringify(pooled.nodes) &&
    JSON.stringify(single.edges) === JSON.stringify(pooled.edges);
  const poolErrors = pooled.stats.pluginErrors.length;
  const ok = same && poolErrors === 0 && stats !== undefined && stats.completed >= PY_FILES;
  console.log(
    JSON.stringify({
      ok,
      same,
      nodes: pooled.nodes.length,
      edges: pooled.edges.length,
      pluginErrors: poolErrors,
      spawned: stats?.spawned,
      completed: stats?.completed,
    }),
  );
  await shutdownSharedPool();
  await rm(dir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.log(
    JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  await shutdownSharedPool();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  process.exit(1);
}
