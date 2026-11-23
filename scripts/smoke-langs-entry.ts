// Bundle smoke test for the language plugins. Built by verify-bundle.ts into a TEMPORARY file
// next to server.js and extract-worker.js (never shipped), and run with NO grammar variables:
// the env defaults banner must find app/grammars and app/queries through the bundle layout.
// It analyzes a tiny Go + Java + JavaScript directory on the main thread and then on 2 worker
// threads (started from the bundled extract-worker.js). Both runs must give the same graph,
// resolve one call per language and report no plugin or parse errors.
// Exit code 0 = ok, 1 = failure. Prints one JSON line.
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

const FILES: Record<string, string> = {
  "go.mod": "module example.com/tiny\n\ngo 1.22\n",
  "util/util.go": "package util\n\nfunc Double(x int) int {\n\treturn x * 2\n}\n",
  "util/more.go": "package util\n\nfunc Triple(x int) int {\n\treturn x * 3\n}\n",
  "cmd/main.go":
    'package main\n\nimport "example.com/tiny/util"\n\nfunc main() {\n\t_ = util.Double(util.Triple(2))\n}\n',
  "cmd/extra.go": "package main\n\nfunc extra() int {\n\treturn 1\n}\n",
  "java/src/main/java/demo/Greeter.java":
    'package demo;\n\npublic class Greeter {\n  public String greet(String n) {\n    return "hi " + n;\n  }\n}\n',
  "java/src/main/java/demo/Other.java":
    "package demo;\n\npublic class Other {\n  public int one() {\n    return 1;\n  }\n}\n",
  "java/src/main/java/demo/App.java":
    'package demo;\n\npublic class App {\n  public static void main(String[] args) {\n    Greeter g = new Greeter();\n    g.greet("x");\n  }\n}\n',
  "java/src/main/java/demo/Third.java": "package demo;\n\npublic class Third {\n}\n",
  "js/lib.js": "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n",
  "js/main.js":
    'const { add } = require("./lib");\nfunction run() {\n  return add(1, 2);\n}\nrun();\n',
};

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "repoatlas-langsmoke-"));
  for (const [rel, content] of Object.entries(FILES)) {
    const file = path.join(dir, ...rel.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return dir;
}

async function analyze(dir: string, workers: number | undefined): Promise<PipelineResult> {
  const out = await analyzeRepository({
    fetcher: new LocalDirFetcher({ dir, owner: "smoke", repo: "langs" }),
    request: { owner: "smoke", repo: "langs" },
    limits: DEFAULT_LIMITS,
    plugins: [...createDefaultRegistry().plugins],
    destDirFor: () => dir,
    // filesPerWorker 1 lets this tiny directory use the pool (the default needs 50 files each).
    extractPool: workers === undefined ? undefined : { workers, filesPerWorker: 1 },
  });
  if (out.status !== "analyzed") throw new Error("analysis was skipped");
  return out.result;
}

function callEdgeCount(result: PipelineResult, srcPart: string, dstPart: string): number {
  return result.edges.filter(
    (e) => e.kind === "calls" && e.src.includes(srcPart) && e.dst.includes(dstPart),
  ).length;
}

let dir: string | undefined;
try {
  dir = await makeRepo();
  const single = await analyze(dir, undefined);
  const pooled = await analyze(dir, 2);
  const pool = sharedPoolStats();
  const same =
    JSON.stringify(single.nodes) === JSON.stringify(pooled.nodes) &&
    JSON.stringify(single.edges) === JSON.stringify(pooled.edges);
  const calls = {
    go: callEdgeCount(pooled, "main", "Double"),
    java: callEdgeCount(pooled, "main", "greet"),
    javascript: callEdgeCount(pooled, "run", "add"),
  };
  const languages = Object.keys(pooled.stats.languages).sort();
  const errors = single.stats.pluginErrors.length + pooled.stats.pluginErrors.length;
  const parseErrors = pooled.stats.parseErrorFiles + single.stats.parseErrorFiles;
  const ok =
    same &&
    errors === 0 &&
    parseErrors === 0 &&
    calls.go > 0 &&
    calls.java > 0 &&
    calls.javascript > 0 &&
    languages.join(",") === "go,java,javascript" &&
    pool !== undefined &&
    pool.completed >= 8; // 5 Go + 4 Java files go through the pool; JavaScript is Tier 3
  console.log(
    JSON.stringify({
      ok,
      same,
      languages,
      calls,
      pluginErrors: errors,
      parseErrors,
      spawned: pool?.spawned,
      completed: pool?.completed,
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
