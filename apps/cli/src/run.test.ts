import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { AnalysisError, type Fetcher } from "@repoatlas/core";
import { GraphEdgeSchema, GraphNodeSchema, SCHEMA_VERSION } from "@repoatlas/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunDeps, run } from "./run.ts";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/typescript/repo", import.meta.url));
const PY_FIXTURE = fileURLToPath(new URL("../../../fixtures/python/repo", import.meta.url));
const SECRET_TOKEN = "ghp_SECRET_TOKEN_VALUE_123";

function capture() {
  let out = "";
  let err = "";
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  return { stdout, stderr, text: () => ({ out, err }) };
}

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "repoatlas-cli-test-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function runCli(argv: string[], deps: RunDeps = {}) {
  const io = capture();
  const code = await run(argv, {
    stdout: io.stdout,
    stderr: io.stderr,
    tmpRoot: workDir,
    env: { GITHUB_TOKEN: SECRET_TOKEN },
    // Never touch the real cache file from tests.
    extractionCache: null,
    ...deps,
  });
  return { code, ...io.text() };
}

describe("run", () => {
  it("uses the extraction cache file on the second run and skips it with --no-cache", async () => {
    const env = { CLI_CACHE_FILE: path.join(workDir, "cache.db") };
    const first = await runCli(["--local", PY_FIXTURE], { env, extractionCache: undefined });
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/hits: 0, misses: [1-9]/);
    const second = await runCli(["--local", PY_FIXTURE], { env, extractionCache: undefined });
    expect(second.out).toMatch(/hits: [1-9][0-9]*, misses: [0-9]+/);
    const off = await runCli(["--local", PY_FIXTURE, "--no-cache"], {
      env,
      extractionCache: undefined,
    });
    expect(off.code).toBe(0);
    expect(off.out).not.toContain("Extraction cache");
  }, 60_000);

  it("prints a report for a local directory", async () => {
    const { code, out, err } = await runCli(["--local", FIXTURE]);
    expect(code).toBe(0);
    expect(out).toContain("Languages");
    expect(out).toContain("typescript:");
    expect(out).toContain("Nodes by kind");
    expect(out).toContain("Edges by confidence");
    expect(out).toContain("Timings (ms)");
    expect(out).not.toContain(SECRET_TOKEN);
    expect(err).not.toContain(SECRET_TOKEN);
  });

  it("writes a valid, deterministic --out file atomically", async () => {
    const outFile = path.join(workDir, "nested", "graph.json");
    const first = await runCli(["--local", FIXTURE, "--out", outFile]);
    expect(first.code).toBe(0);

    const text = await readFile(outFile, "utf8");
    const doc = JSON.parse(text) as {
      schemaVersion: number;
      repo: { commitSha: string };
      nodes: unknown[];
      edges: unknown[];
      rollups: unknown[];
      unresolved: unknown[];
      stats: unknown;
    };
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.repo.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(doc.nodes.length).toBeGreaterThan(0);
    for (const node of doc.nodes) expect(GraphNodeSchema.safeParse(node).success).toBe(true);
    for (const edge of doc.edges) expect(GraphEdgeSchema.safeParse(edge).success).toBe(true);
    expect(Array.isArray(doc.rollups)).toBe(true);
    expect(Array.isArray(doc.unresolved)).toBe(true);

    // No temp files left behind.
    expect(await readdir(path.dirname(outFile))).toEqual(["graph.json"]);

    // Same input gives the same nodes and edges (stats contain timings, so compare the rest).
    const outFile2 = path.join(workDir, "graph2.json");
    await runCli(["--local", FIXTURE, "--out", outFile2]);
    const doc2 = JSON.parse(await readFile(outFile2, "utf8")) as typeof doc;
    expect(doc2.nodes).toEqual(doc.nodes);
    expect(doc2.edges).toEqual(doc.edges);
    expect(doc2.rollups).toEqual(doc.rollups);
  });

  it("reports INVALID_REPO_URL for a bad url without touching the network", async () => {
    const { code, err } = await runCli(["https://example.com/a/b"]);
    expect(code).toBe(2);
    expect(err).toContain("INVALID_REPO_URL");
    expect(err).not.toContain(SECRET_TOKEN);
  });

  it("returns 1 and usage for a usage error", async () => {
    const { code, err } = await runCli([]);
    expect(code).toBe(1);
    expect(err).toContain("Usage:");
  });

  it("returns 1 for an invalid limit in the environment", async () => {
    const { code, err } = await runCli(["--local", FIXTURE], { env: { MAX_FILES: "abc" } });
    expect(code).toBe(1);
    expect(err).toContain("MAX_FILES");
  });

  it("maps an AnalysisError from the fetcher to exit code 2", async () => {
    const fetcher: Fetcher = {
      resolve: () =>
        Promise.reject(new AnalysisError("REPO_NOT_FOUND", `not found (${SECRET_TOKEN})`)),
      fetch: () => Promise.reject(new Error("unreachable")),
    };
    const { code, out, err } = await runCli(["acme/missing"], { fetcher });
    expect(code).toBe(2);
    expect(err).toContain("REPO_NOT_FOUND");
    expect(out + err).not.toContain(SECRET_TOKEN);
  });

  it("cleans up its temp directory", async () => {
    await runCli(["--local", FIXTURE]);
    expect(await readdir(workDir)).toEqual([]);
  });
});
