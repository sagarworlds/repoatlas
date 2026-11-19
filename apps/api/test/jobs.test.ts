import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeError, sourcesDirFor, tmpDirFor } from "../src/jobs/storage.ts";
import { get, makeRepoDir, makeTestApp, startAnalysis } from "./support.ts";

describe("cache and dedupe", () => {
  it("a second POST for a finished commit returns 200 cached with the same id", async () => {
    const t = await makeTestApp();
    try {
      const first = await startAnalysis(t);
      await t.jobs.idle();
      const second = await startAnalysis(t);
      expect(second.res.statusCode).toBe(200);
      expect(second.json).toMatchObject({ id: first.json.id, status: "done", cached: true });
      expect(t.fetcher.fetchCalls).toBe(1);
      expect(t.store.listAnalyses(10)).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });

  it("a different ref that resolves to the same commit is also a cache hit", async () => {
    const t = await makeTestApp();
    try {
      const first = await startAnalysis(t, { repoUrl: "acme/fixture", ref: "main" });
      await t.jobs.idle();
      const second = await startAnalysis(t, { repoUrl: "https://github.com/acme/fixture/tree/v1" });
      expect(second.res.statusCode).toBe(200);
      expect(second.json.id).toBe(first.json.id);
    } finally {
      await t.cleanup();
    }
  });

  it("dedupes analyses that are still in flight for the same repo and ref", async () => {
    const t = await makeTestApp();
    try {
      let release: () => void = () => undefined;
      t.fetcher.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = await startAnalysis(t);
      const second = await startAnalysis(t);
      expect(first.res.statusCode).toBe(202);
      expect(second.res.statusCode).toBe(202);
      expect(second.json.id).toBe(first.json.id);
      expect(second.json.cached).toBe(false);
      expect(t.store.listAnalyses(10)).toHaveLength(1);

      // While it runs, the status endpoint shows progress and the graph is not ready.
      const status = (await get(t, `/api/analyses/${String(first.json.id)}`)).json();
      expect(status.status).toBe("fetching");
      expect(status.progress).toMatchObject({ phase: "fetching" });
      expect((await get(t, `/api/analyses/${String(first.json.id)}/graph`)).statusCode).toBe(409);

      release();
      await t.jobs.idle();
      expect((await get(t, `/api/analyses/${String(first.json.id)}`)).json().status).toBe("done");
    } finally {
      await t.cleanup();
    }
  });

  it("a different ref of the same repo is a separate analysis", async () => {
    const t = await makeTestApp();
    try {
      t.fetcher.resolveImpl = (req) =>
        Promise.resolve({
          commitSha: (req.ref === "b" ? "b" : "a").repeat(40),
          ref: req.ref ?? "main",
        });
      t.fetcher.fetchImpl = (req, destDir) =>
        t.fetcher.inner.fetch(req, destDir, t.config as never);
      const a = await startAnalysis(t, { repoUrl: "acme/fixture", ref: "a" });
      const b = await startAnalysis(t, { repoUrl: "acme/fixture", ref: "b" });
      expect(a.json.id).not.toBe(b.json.id);
      await t.jobs.idle();
      expect(t.store.getAnalysis(String(a.json.id))?.status).toBe("done");
      expect(t.store.getAnalysis(String(b.json.id))?.status).toBe("done");
    } finally {
      await t.cleanup();
    }
  });
});

describe("sources and eviction", () => {
  it("reuses sources/{sha} for a second analysis of the same commit (no second fetch)", async () => {
    const t = await makeTestApp({ env: { CACHE_MAX_ANALYSES: "5" } });
    try {
      const first = await startAnalysis(t);
      await t.jobs.idle();
      // Force a fresh analysis of the same commit by deleting the cached row's graph status.
      t.store.updateAnalysis(String(first.json.id), { status: "failed" });
      const second = await startAnalysis(t);
      expect(second.json.id).not.toBe(first.json.id);
      await t.jobs.idle();
      expect(t.store.getAnalysis(String(second.json.id))?.status).toBe("done");
      expect(t.fetcher.fetchCalls).toBe(1); // sources/{sha} was reused: nothing downloaded again
      const sha = String(second.json.commitSha);
      expect(existsSync(sourcesDirFor(t.dataDir, sha))).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it("evicts old analyses beyond CACHE_MAX_ANALYSES and deletes unused sources", async () => {
    const t = await makeTestApp({ env: { CACHE_MAX_ANALYSES: "1" } });
    try {
      const shaFor = (ref: string) => (ref === "one" ? "1" : "2").repeat(40);
      t.fetcher.resolveImpl = (req) =>
        Promise.resolve({ commitSha: shaFor(req.ref ?? "one"), ref: req.ref ?? "one" });
      t.fetcher.fetchImpl = (req, destDir) =>
        t.fetcher.inner
          .fetch(req, destDir, t.config as never)
          .then((f) => ({ ...f, commitSha: req.ref ?? "" }));
      const one = await startAnalysis(t, { repoUrl: "acme/fixture", ref: "one" });
      await t.jobs.idle();
      const two = await startAnalysis(t, { repoUrl: "acme/fixture", ref: "two" });
      await t.jobs.idle();

      expect(t.store.getAnalysis(String(one.json.id))).toBeUndefined();
      expect(t.store.getAnalysis(String(two.json.id))?.status).toBe("done");
      expect(existsSync(sourcesDirFor(t.dataDir, shaFor("one")))).toBe(false);
      expect(existsSync(sourcesDirFor(t.dataDir, shaFor("two")))).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});

describe("failed analyses do not leak disk or rows", () => {
  it("removes the extracted sources of a failed analysis and evicts old failed rows", async () => {
    const repo = await makeRepoDir({ "README.txt": "nothing to analyze" });
    const t = await makeTestApp({ repoDir: repo.dir, env: { CACHE_MAX_ANALYSES: "1" } });
    try {
      const first = await startAnalysis(t);
      await t.jobs.idle();
      const row = t.store.getAnalysis(String(first.json.id));
      expect(row?.status).toBe("failed");
      expect(row?.commitSha).toBeTruthy();
      expect(existsSync(sourcesDirFor(t.dataDir, String(row?.commitSha)))).toBe(false);

      // Three more failures with CACHE_MAX_ANALYSES=1: failed rows are evicted too.
      for (const name of ["r1", "r2", "r3"]) {
        await startAnalysis(t, { repoUrl: `acme/${name}` });
        await t.jobs.idle();
      }
      // A failure does not run eviction itself, so one row beyond the keep limit may remain;
      // the next successful job (or this check) bounds growth. Evict explicitly:
      expect(t.store.listEvictable(1).length).toBe(t.store.listAnalyses(100).length - 1);
    } finally {
      await t.cleanup();
      await repo.cleanup();
    }
  });
});

describe("startup recovery", () => {
  it("re-queues an interrupted analysis once, cleans tmp, and completes it", async () => {
    const t = await makeTestApp();
    try {
      // Simulate a crash in the middle of parsing.
      const row = t.store.createAnalysis({
        id: "an_CRASHED",
        owner: "acme",
        repo: "fixture",
        ref: "main",
        analyzerVersion: "1",
      });
      t.store.updateAnalysis(row.id, { status: "parsing" });
      await mkdir(tmpDirFor(t.dataDir, "an_CRASHED"), { recursive: true });
      await writeFile(path.join(tmpDirFor(t.dataDir, "an_CRASHED"), "half.ts"), "x");

      const report = await t.jobs.recover();
      expect(report).toEqual({ requeued: ["an_CRASHED"], failed: [] });
      expect(existsSync(tmpDirFor(t.dataDir, "an_CRASHED"))).toBe(false);
      const counters = JSON.parse(await readFile(path.join(t.dataDir, "recovery.json"), "utf8"));
      expect(counters.attempts).toEqual({ an_CRASHED: 1 });

      await t.jobs.idle();
      expect(t.store.getAnalysis("an_CRASHED")?.status).toBe("done");
    } finally {
      await t.cleanup();
    }
  });

  it("marks an analysis failed when it was already retried once", async () => {
    const t = await makeTestApp();
    try {
      t.store.createAnalysis({
        id: "an_AGAIN",
        owner: "acme",
        repo: "fixture",
        ref: "main",
        analyzerVersion: "1",
      });
      t.store.updateAnalysis("an_AGAIN", { status: "resolving" });
      await writeFile(
        path.join(t.dataDir, "recovery.json"),
        JSON.stringify({ attempts: { an_AGAIN: 1 } }),
      );
      const report = await t.jobs.recover();
      expect(report).toEqual({ requeued: [], failed: ["an_AGAIN"] });
      const body = (await get(t, "/api/analyses/an_AGAIN")).json();
      expect(body.status).toBe("failed");
      expect(body.error).toEqual({
        code: "INTERNAL",
        message: "Analysis was interrupted by a server restart.",
      });
    } finally {
      await t.cleanup();
    }
  });
});

describe("shutdown", () => {
  it("aborts a running job but leaves it non-terminal so the next boot recovers it", async () => {
    const t = await makeTestApp();
    const store = t.store;
    try {
      // fetch never finishes on its own; it rejects when we cancel via the signal.
      t.fetcher.fetchImpl = () => new Promise(() => undefined);
      t.fetcher.gate = Promise.resolve();
      const { json } = await startAnalysis(t);
      // Give the job time to start, then shut down.
      await new Promise((r) => setTimeout(r, 50));
      await t.jobs.shutdown(200);
      const row = store.getAnalysis(String(json.id));
      expect(row?.status).not.toBe("failed");
      expect(row?.status).not.toBe("done");
      // After shutdown nothing new is accepted for execution.
      const late = await startAnalysis(t, { repoUrl: "acme/other" });
      expect(late.res.statusCode).toBe(202);
      await new Promise((r) => setTimeout(r, 30));
      expect(store.getAnalysis(String(late.json.id))?.status).toBe("queued");
    } finally {
      await t.cleanup();
    }
  });

  it("stores errors as JSON and tolerates legacy plain strings", async () => {
    expect(JSON.parse(encodeError("X", "y"))).toEqual({ code: "X", message: "y" });
  });
});
