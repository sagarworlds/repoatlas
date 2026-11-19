import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDefaultRegistry,
  type FetchedRepo,
  type Fetcher,
  type Limits,
  LocalDirFetcher,
  type RepoRequest,
} from "@repoatlas/core";
import { type GraphStore, openStore } from "@repoatlas/store";
import type { FastifyInstance } from "fastify";
import { type Config, parseConfig } from "../src/config.ts";
import type { AnalysisJobs } from "../src/jobs/manager.ts";
import { buildServer } from "../src/server.ts";

/** Located from this file, never from process.cwd(). */
export const TS_FIXTURE_REPO = fileURLToPath(
  new URL("../../../fixtures/typescript/repo", import.meta.url),
);

export const REPO_URL = "https://github.com/acme/fixture";

type Resolved = { commitSha: string; ref: string };

/**
 * A fetcher for failure injection. By default it behaves like a LocalDirFetcher; each
 * method can be overridden, and `gate` holds `fetch` until the test releases it.
 */
export class ScriptedFetcher implements Fetcher {
  readonly inner: LocalDirFetcher;
  resolveCalls = 0;
  fetchCalls = 0;
  resolveImpl: ((req: RepoRequest) => Promise<Resolved>) | undefined;
  fetchImpl: ((req: RepoRequest, destDir: string) => Promise<FetchedRepo>) | undefined;
  gate: Promise<void> | undefined;

  constructor(dir: string, commitSha?: string) {
    this.inner = new LocalDirFetcher(commitSha === undefined ? { dir } : { dir, commitSha });
  }

  resolve(req: RepoRequest): Promise<Resolved> {
    this.resolveCalls += 1;
    return this.resolveImpl ? this.resolveImpl(req) : this.inner.resolve(req);
  }

  async fetch(req: RepoRequest, destDir: string, limits: Limits): Promise<FetchedRepo> {
    this.fetchCalls += 1;
    if (this.gate) await this.gate;
    return this.fetchImpl ? this.fetchImpl(req, destDir) : this.inner.fetch(req, destDir, limits);
  }
}

export interface TestApp {
  app: FastifyInstance;
  jobs: AnalysisJobs;
  store: GraphStore;
  config: Config;
  dataDir: string;
  fetcher: ScriptedFetcher;
  cleanup: () => Promise<void>;
}

export interface TestAppOptions {
  /** Directory the fake fetcher serves. Default: the TypeScript fixture. */
  repoDir?: string;
  env?: Record<string, string>;
  store?: GraphStore;
  dataDir?: string;
}

export async function makeTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const dataDir = options.dataDir ?? (await mkdtemp(path.join(tmpdir(), "ra-api-")));
  const config = parseConfig(
    {
      LOG_LEVEL: "silent",
      DATA_DIR: dataDir,
      // Generous limits so unrelated tests never hit the rate limiter.
      RATE_LIMIT_ANALYSES_MAX: "1000",
      RATE_LIMIT_GENERAL_MAX: "100000",
      ...options.env,
    },
    dataDir,
  );
  const store = options.store ?? openStore(":memory:");
  const fetcher = new ScriptedFetcher(options.repoDir ?? TS_FIXTURE_REPO);
  const { app, jobs } = await buildServer({
    config,
    store,
    fetcher,
    plugins: [...createDefaultRegistry().plugins],
  });
  await app.ready();
  return {
    app,
    jobs,
    store,
    config,
    dataDir,
    fetcher,
    cleanup: async () => {
      await jobs.shutdown(1000);
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Creates a temp directory with the given files. */
export async function makeRepoDir(
  files: Record<string, string>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ra-api-repo-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** POST /api/analyses and return the parsed response. */
export async function startAnalysis(
  t: TestApp,
  body: Record<string, unknown> = { repoUrl: REPO_URL },
) {
  const res = await t.app.inject({ method: "POST", url: "/api/analyses", payload: body });
  return { res, json: res.json() as Record<string, unknown> };
}

/** Starts an analysis and waits until the queue is idle (the job finished). */
export async function analyzeAndWait(t: TestApp): Promise<string> {
  const { res, json } = await startAnalysis(t);
  if (res.statusCode !== 202) throw new Error(`unexpected start status ${res.statusCode}`);
  await t.jobs.idle();
  return String(json.id);
}

export function get(t: TestApp, url: string) {
  return t.app.inject({ method: "GET", url });
}
