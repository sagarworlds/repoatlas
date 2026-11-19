import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AnalysisError, type AnalysisErrorCode } from "@repoatlas/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourcesDirFor } from "../src/jobs/storage.ts";
import {
  analyzeAndWait,
  get,
  makeRepoDir,
  makeTestApp,
  startAnalysis,
  type TestApp,
} from "./support.ts";

type ErrorJson = { error: { code: string; message: string } };

describe("error shape and codes", () => {
  let t: TestApp;
  let id: string;
  beforeAll(async () => {
    t = await makeTestApp();
    id = await analyzeAndWait(t);
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it("INVALID_REPO_URL (400) for bad URLs, with no cause leaked", async () => {
    const callsBefore = t.fetcher.resolveCalls;
    for (const repoUrl of [
      "http://github.com/a/b",
      "https://github.com.evil.com/a/b",
      "git@github.com:a/b.git",
      "file:///etc/passwd",
      "https://github.com/a/b/../c",
    ]) {
      const { res, json } = await startAnalysis(t, { repoUrl });
      expect(res.statusCode, repoUrl).toBe(400);
      expect((json as unknown as ErrorJson).error.code).toBe("INVALID_REPO_URL");
    }
    expect(t.fetcher.resolveCalls).toBe(callsBefore); // rejected before any fetcher call
  });

  it("VALIDATION_ERROR (400) for a malformed body", async () => {
    for (const payload of [
      {},
      { repoUrl: 5 },
      { repoUrl: "a/b", ref: "x..y" },
      { repoUrl: "a/b", ref: "bad ref" },
    ]) {
      const { res, json } = await startAnalysis(t, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect((json as unknown as ErrorJson).error.code).toBe("VALIDATION_ERROR");
    }
    const notJson = await t.app.inject({
      method: "POST",
      url: "/api/analyses",
      headers: { "content-type": "application/json" },
      payload: "{oops",
    });
    expect(notJson.statusCode).toBe(400);
    expect((notJson.json() as ErrorJson).error.code).toBe("VALIDATION_ERROR");
  });

  it("ANALYSIS_NOT_FOUND (404) on every analysis route", async () => {
    for (const suffix of [
      "",
      "/graph",
      "/node?nodeId=x",
      "/callflow?nodeId=x",
      "/deps?file=x",
      "/search?q=x",
      "/source?file=x",
    ]) {
      const res = await get(t, `/api/analyses/an_nope${suffix}`);
      expect(res.statusCode, suffix).toBe(404);
      expect((res.json() as ErrorJson).error.code).toBe("ANALYSIS_NOT_FOUND");
    }
  });

  it("ANALYSIS_NOT_READY (409) while queued or after a failure", async () => {
    const queued = t.store.createAnalysis({
      id: "an_queued",
      owner: "a",
      repo: "b",
      ref: "main",
      analyzerVersion: "1",
    });
    const res = await get(t, `/api/analyses/${queued.id}/graph`);
    expect(res.statusCode).toBe(409);
    expect((res.json() as ErrorJson).error.code).toBe("ANALYSIS_NOT_READY");
    t.store.updateAnalysis(queued.id, { status: "failed" });
    expect((await get(t, `/api/analyses/${queued.id}/search?q=x`)).statusCode).toBe(409);
    // ...but the status endpoint itself always works.
    expect((await get(t, `/api/analyses/${queued.id}`)).statusCode).toBe(200);
  });

  it("NODE_NOT_FOUND (404) for unknown node ids", async () => {
    for (const route of ["node", "callflow"]) {
      const res = await get(t, `/api/analyses/${id}/${route}?nodeId=sym%3Anope.ts%23x`);
      expect(res.statusCode, route).toBe(404);
      expect((res.json() as ErrorJson).error.code).toBe("NODE_NOT_FOUND");
    }
  });

  it("FILE_NOT_FOUND (404) for unknown files in deps and source", async () => {
    for (const route of ["deps", "source"]) {
      const res = await get(t, `/api/analyses/${id}/${route}?file=src/missing.ts`);
      expect(res.statusCode, route).toBe(404);
      expect((res.json() as ErrorJson).error.code).toBe("FILE_NOT_FOUND");
    }
  });

  it("unknown routes use the same error shape", async () => {
    const res = await get(t, "/api/does-not-exist");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found." } });
    expect((await t.app.inject({ method: "DELETE", url: "/api/analyses" })).statusCode).toBe(404);
  });

  it("sends security headers and restricts CORS to the configured origin", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const evil = await t.app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://evil.example" },
    });
    // A fixed origin is echoed as configured, never reflected from the request.
    expect(evil.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});

describe("failures that need a special fetcher or repo", () => {
  it("NO_SUPPORTED_LANGUAGES: the analysis fails with a 422-class code", async () => {
    const repo = await makeRepoDir({ "README.md": "# nothing to analyze\n", "notes.txt": "hi" });
    const t = await makeTestApp({ repoDir: repo.dir });
    try {
      const { json } = await startAnalysis(t);
      await t.jobs.idle();
      const res = await get(t, `/api/analyses/${String(json.id)}`);
      expect(res.json()).toMatchObject({
        status: "failed",
        error: { code: "NO_SUPPORTED_LANGUAGES" },
      });
      expect(res.json().finishedAt).not.toBeNull();
    } finally {
      await t.cleanup();
      await repo.cleanup();
    }
  });

  const synchronous: [AnalysisErrorCode, number][] = [
    ["REPO_NOT_FOUND", 404],
    ["REPO_PRIVATE", 403],
    ["RATE_LIMITED", 429],
    ["REPO_TOO_LARGE", 422],
    ["TIMEOUT", 504],
    ["NO_SUPPORTED_LANGUAGES", 422],
    ["INTERNAL", 500],
  ];
  it.each(synchronous)("POST maps resolve() failure %s to HTTP %i", async (code, status) => {
    const t = await makeTestApp();
    try {
      t.fetcher.resolveImpl = () =>
        Promise.reject(
          new AnalysisError(code, "safe message", { cause: new Error("secret ghp_TOKEN") }),
        );
      const { res, json } = await startAnalysis(t);
      expect(res.statusCode).toBe(status);
      const body = json as unknown as ErrorJson;
      expect(body.error.code).toBe(code);
      expect(JSON.stringify(body)).not.toContain("ghp_TOKEN");
      expect(t.store.listAnalyses(10)).toHaveLength(0); // nothing queued
    } finally {
      await t.cleanup();
    }
  });

  it("unexpected exceptions become INTERNAL without leaking details", async () => {
    const t = await makeTestApp();
    try {
      t.fetcher.resolveImpl = () =>
        Promise.reject(new Error("boom: token ghp_SECRET at C:/secret/path"));
      const { res, json } = await startAnalysis(t);
      expect(res.statusCode).toBe(500);
      expect(json).toEqual({ error: { code: "INTERNAL", message: "Internal server error." } });
    } finally {
      await t.cleanup();
    }
  });

  it("a crashing fetch marks the analysis failed with a generic message", async () => {
    const t = await makeTestApp();
    try {
      t.fetcher.fetchImpl = () => Promise.reject(new Error("disk exploded at C:/secret"));
      const { json } = await startAnalysis(t);
      await t.jobs.idle();
      const body = (await get(t, `/api/analyses/${String(json.id)}`)).json();
      expect(body.status).toBe("failed");
      expect(body.error.code).toBe("INTERNAL");
      expect(JSON.stringify(body)).not.toContain("secret");
    } finally {
      await t.cleanup();
    }
  });

  it("a pipeline error keeps its code on the failed analysis", async () => {
    const t = await makeTestApp();
    try {
      t.fetcher.fetchImpl = () =>
        Promise.reject(new AnalysisError("REPO_TOO_LARGE", "Repository is too large."));
      const { json } = await startAnalysis(t);
      await t.jobs.idle();
      const body = (await get(t, `/api/analyses/${String(json.id)}`)).json();
      expect(body.error).toEqual({ code: "REPO_TOO_LARGE", message: "Repository is too large." });
    } finally {
      await t.cleanup();
    }
  });

  it("RATE_LIMITED (429): POST is limited per IP, other routes use their own limit", async () => {
    const t = await makeTestApp({
      env: { RATE_LIMIT_ANALYSES_MAX: "2", RATE_LIMIT_GENERAL_MAX: "5" },
    });
    try {
      expect((await startAnalysis(t)).res.statusCode).toBe(202);
      expect((await startAnalysis(t)).res.statusCode).toBe(202);
      const limited = await startAnalysis(t);
      expect(limited.res.statusCode).toBe(429);
      expect(limited.json).toEqual({
        error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
      });
      await t.jobs.idle();
      let last = 200;
      for (let i = 0; i < 8; i++) last = (await get(t, "/api/health")).statusCode;
      expect(last).toBe(429);
    } finally {
      await t.cleanup();
    }
  });

  it("does not trust X-Forwarded-For unless TRUST_PROXY is set", async () => {
    const t = await makeTestApp({ env: { RATE_LIMIT_GENERAL_MAX: "2" } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await t.app.inject({
          method: "GET",
          url: "/api/health",
          headers: { "x-forwarded-for": `10.0.0.${i}` },
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([200, 200, 429, 429]);
    } finally {
      await t.cleanup();
    }
  });
});

describe("TRUST_PROXY hop count", () => {
  it("ignores a spoofed leftmost X-Forwarded-For when one proxy hop is trusted", async () => {
    const t = await makeTestApp({
      env: { TRUST_PROXY: "1", RATE_LIMIT_GENERAL_MAX: "2" },
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await t.app.inject({
          method: "GET",
          url: "/api/health",
          remoteAddress: "127.0.0.1",
          // The client invents the first entry; the proxy appends the real address.
          headers: { "x-forwarded-for": `1.2.3.${i}, 203.0.113.9` },
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([200, 200, 429, 429, 429]);
    } finally {
      await t.cleanup();
    }
  });
});

describe("source endpoint security", () => {
  let t: TestApp;
  let id: string;
  beforeAll(async () => {
    t = await makeTestApp();
    id = await analyzeAndWait(t);
    // A secret OUTSIDE the sources directory, to prove it cannot be reached.
    await writeFile(path.join(t.dataDir, "secret.txt"), "TOP SECRET");
  });
  afterAll(async () => {
    await t.cleanup();
  });

  const attempts = [
    "../../etc/passwd",
    "../../../../../../etc/passwd",
    "..%2F..%2Fetc%2Fpasswd",
    "%2e%2e/%2e%2e/etc/passwd",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "C:\\Windows\\win.ini",
    "..\\..\\secret.txt",
    "src\\service.ts",
    "src/../src/service.ts",
    "./src/service.ts",
    "src//service.ts",
    "../secret.txt",
    "../../secret.txt",
    "file:///etc/passwd",
    "src",
    "dir:src",
  ];
  it.each(attempts)("rejects %s with 404 FILE_NOT_FOUND", async (file) => {
    // `file` may already contain %-escapes on purpose; encode the rest like a client would.
    const encoded = file.includes("%") ? file : encodeURIComponent(file);
    const res = await get(t, `/api/analyses/${id}/source?file=${encoded}`);
    expect(res.statusCode).toBe(404);
    expect((res.json() as ErrorJson).error.code).toBe("FILE_NOT_FOUND");
    expect(res.body).not.toContain("TOP SECRET");
    expect(res.body).not.toContain("root:");
  });

  it("rejects a NUL byte in the path with 400 before touching the disk", async () => {
    const res = await get(t, `/api/analyses/${id}/source?file=src/service.ts%00.png`);
    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorJson).error.code).toBe("VALIDATION_ERROR");
  });

  it("does not follow a symlink planted inside the sources directory", async () => {
    const sha = t.store.getAnalysis(id)?.commitSha ?? "";
    const link = path.join(sourcesDirFor(t.dataDir, sha), "src", "evil.ts");
    try {
      await symlink(path.join(t.dataDir, "secret.txt"), link);
    } catch {
      return; // creating symlinks needs privileges on Windows; nothing to test then
    }
    // Even if a node existed for it, realpath escapes the root and the file is refused.
    t.store.saveGraph(id, {
      nodes: [
        { id: "repo:", kind: "repo", name: "x" },
        { id: "file:src/evil.ts", kind: "file", name: "evil.ts", file: "src/evil.ts" },
      ],
      edges: [],
      rollups: [],
      unresolved: [],
    });
    const res = await get(t, `/api/analyses/${id}/source?file=src/evil.ts`);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("TOP SECRET");
    await mkdir(path.join(t.dataDir, "unused"), { recursive: true });
  });

  it("refuses to read a file that has a node but is missing on disk", async () => {
    t.store.saveGraph(id, {
      nodes: [
        { id: "repo:", kind: "repo", name: "x" },
        { id: "file:src/ghost.ts", kind: "file", name: "ghost.ts", file: "src/ghost.ts" },
      ],
      edges: [],
      rollups: [],
      unresolved: [],
    });
    const res = await get(t, `/api/analyses/${id}/source?file=src/ghost.ts`);
    expect(res.statusCode).toBe(404);
  });
});
