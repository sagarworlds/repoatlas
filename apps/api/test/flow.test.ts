import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourcesDirFor } from "../src/jobs/storage.ts";
import {
  analyzeAndWait,
  get,
  makeTestApp,
  REPO_URL,
  startAnalysis,
  type TestApp,
  TS_FIXTURE_REPO,
} from "./support.ts";

let t: TestApp;
let id: string;

beforeAll(async () => {
  t = await makeTestApp();
  id = await analyzeAndWait(t);
});
afterAll(async () => {
  await t.cleanup();
});

describe("analysis lifecycle", () => {
  it("POST answers 202 queued with the resolved ref and SHA", async () => {
    const t2 = await makeTestApp();
    try {
      const { res, json } = await startAnalysis(t2, { repoUrl: REPO_URL, ref: "dev" });
      expect(res.statusCode).toBe(202);
      expect(json).toMatchObject({
        status: "queued",
        owner: "acme",
        repo: "fixture",
        ref: "dev",
        cached: false,
      });
      expect(String(json.id)).toMatch(/^an_[0-9A-Z]{26}$/);
      expect(String(json.commitSha)).toMatch(/^[0-9a-f]{40}$/);
      await t2.jobs.idle();
    } finally {
      await t2.cleanup();
    }
  });

  it("GET /api/analyses/:id shows a finished analysis with stats", async () => {
    const res = await get(t, `/api/analyses/${id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ id, owner: "acme", repo: "fixture", status: "done", error: null });
    expect(body.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.finishedAt).not.toBeNull();
    expect(body.stats.languages.typescript.files).toBeGreaterThan(5);
    expect(body.stats.references.resolved).toBeGreaterThan(5);
  });

  it("GET /api/analyses lists recent analyses, newest first, with a limit", async () => {
    const res = await get(t, "/api/analyses?limit=5");
    expect(res.statusCode).toBe(200);
    expect(res.json().analyses[0].id).toBe(id);
    expect((await get(t, "/api/analyses?limit=0")).statusCode).toBe(400);
  });

  it("copies the sources into DATA_DIR/sources/{sha} and removes DATA_DIR/tmp/{id}", async () => {
    const analysis = t.store.getAnalysis(id);
    const sha = analysis?.commitSha ?? "";
    const text = await readFile(
      path.join(sourcesDirFor(t.dataDir, sha), "src", "service.ts"),
      "utf8",
    );
    expect(text).toContain("export function register");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(path.join(t.dataDir, "tmp"))).toEqual([]);
  });
});

describe("graph", () => {
  it("returns directories at the default level", async () => {
    const res = await get(t, `/api/analyses/${id}/graph`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain("dir:src");
    expect(body.truncated).toBe(false);
  });

  it("returns file-level nodes with aggregated import edges", async () => {
    const res = await get(t, `/api/analyses/${id}/graph?level=file&root=dir:src&depth=3`);
    const body = res.json();
    const ids = body.nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain("file:src/service.ts");
    expect(body.edges).toContainEqual(
      expect.objectContaining({
        src: "file:src/service.ts",
        dst: "file:src/models/user.ts",
        kind: "imports",
      }),
    );
  });

  it("returns symbol-level call edges", async () => {
    const res = await get(
      t,
      `/api/analyses/${id}/graph?level=symbol&root=dir:src&depth=5&edgeKinds=calls&minConfidence=exact`,
    );
    const body = res.json();
    expect(body.edges).toContainEqual(
      expect.objectContaining({
        src: "sym:src/models/user.ts#User.save",
        dst: "sym:src/models/user.ts#User.validate",
        kind: "calls",
      }),
    );
  });

  it("hides tests by default and includes them on request", async () => {
    const hidden = (
      await get(t, `/api/analyses/${id}/graph?level=file&root=dir:src&depth=3`)
    ).json();
    const shown = (
      await get(t, `/api/analyses/${id}/graph?level=file&root=dir:src&depth=3&includeTests=true`)
    ).json();
    const idsOf = (b: { nodes: { id: string }[] }) => b.nodes.map((n) => n.id);
    expect(idsOf(hidden)).not.toContain("file:src/user.test.ts");
    expect(idsOf(shown)).toContain("file:src/user.test.ts");
  });

  it("adds external nodes on request", async () => {
    const res = await get(
      t,
      `/api/analyses/${id}/graph?level=file&root=dir:src&depth=3&includeExternal=true`,
    );
    const ids = res.json().nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain("ext:npm:lodash");
  });

  it("rejects bad parameters with VALIDATION_ERROR", async () => {
    for (const q of ["level=banana", "depth=9", "edgeKinds=calls,bogus", "includeTests=maybe"]) {
      const res = await get(t, `/api/analyses/${id}/graph?${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("node, callflow, deps, search", () => {
  const nodeUrl = (nodeId: string) =>
    `/api/analyses/${id}/node?nodeId=${encodeURIComponent(nodeId)}`;

  it("node detail for a class lists its methods and counts", async () => {
    const res = await get(t, nodeUrl("sym:src/models/user.ts#User"));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.node.name).toBe("User");
    expect(body.parents.map((p: { id: string }) => p.id)).toContain("file:src/models/user.ts");
    const childNames = body.children.map((c: { name: string }) => c.name);
    expect(childNames).toEqual(expect.arrayContaining(["save", "create", "validate"]));
  });

  it("node detail counts callers of a method", async () => {
    const res = await get(t, nodeUrl("sym:src/models/user.ts#User.save"));
    expect(res.json().counts.callers).toBeGreaterThan(0);
  });

  it("node detail for a file", async () => {
    const res = await get(t, nodeUrl("file:src/service.ts"));
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.imports).toBeGreaterThan(0);
  });

  it("callflow of register shows its callees with call lines", async () => {
    const focus = "sym:src/service.ts#register";
    const res = await get(
      t,
      `/api/analyses/${id}/callflow?nodeId=${encodeURIComponent(focus)}&depthUp=0&depthDown=1`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.focus).toBe(focus);
    expect(body.nodes[0].id).toBe(focus);
    const dsts = body.edges.map((e: { dst: string }) => e.dst);
    expect(dsts).toEqual(
      expect.arrayContaining([
        "sym:src/models/user.ts#User.constructor",
        "sym:src/models/user.ts#User.save",
        "sym:src/models/user.ts#User.create",
      ]),
    );
    expect(body.edges[0]).toMatchObject({ kind: "calls", confidence: "exact" });
    expect(typeof body.edges[0].line).toBe("number");
  });

  it("callflow clamps depths into 0..4 instead of failing", async () => {
    const focus = encodeURIComponent("sym:src/service.ts#register");
    const res = await get(
      t,
      `/api/analyses/${id}/callflow?nodeId=${focus}&depthUp=99&depthDown=-3`,
    );
    expect(res.statusCode).toBe(200);
  });

  it("deps of a file lists imports and importers", async () => {
    const res = await get(t, `/api/analyses/${id}/deps?file=src/models/user.ts&direction=both`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.nodes.map((n: { id: string }) => n.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "file:src/models/user.ts",
        "file:src/models/base.ts",
        "file:src/service.ts",
      ]),
    );
    const imports = await get(t, `/api/analyses/${id}/deps?file=src/service.ts&direction=imports`);
    expect(imports.json().nodes.map((n: { id: string }) => n.id)).toContain("ext:npm:lodash");
  });

  it("search finds symbols, honours kinds and limit", async () => {
    const res = await get(t, `/api/analyses/${id}/search?q=save`);
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((n: { id: string }) => n.id)).toContain(
      "sym:src/models/user.ts#User.save",
    );
    const onlyClasses = await get(t, `/api/analyses/${id}/search?q=user&kinds=class`);
    for (const n of onlyClasses.json().results) expect(n.kind).toBe("class");
    const limited = await get(t, `/api/analyses/${id}/search?q=e&limit=2`);
    expect(limited.json().results.length).toBeLessThanOrEqual(2);
  });

  it("rejects control characters with 400 instead of a 500", async () => {
    const search = await get(t, `/api/analyses/${id}/search?q=sav%00`);
    expect(search.statusCode).toBe(400);
    expect(search.json().error.code).toBe("VALIDATION_ERROR");
    const node = await get(t, `/api/analyses/${id}/node?nodeId=a%00b`);
    expect(node.statusCode).toBe(400);
  });
});

describe("source", () => {
  it("returns a line range with totalLines and language", async () => {
    const res = await get(t, `/api/analyses/${id}/source?file=src/service.ts&start=7&end=9`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      file: "src/service.ts",
      language: "typescript",
      startLine: 7,
      endLine: 9,
    });
    expect(body.content).toBe(
      [
        "export function register(name: string): string {",
        "  const clean = h(name);",
        "  const u = new User(clean);",
      ].join("\n"),
    );
    expect(body.totalLines).toBeGreaterThan(20);
  });

  it("returns the whole file when no range is given", async () => {
    const res = await get(t, `/api/analyses/${id}/source?file=src/lib/strings.ts`);
    const body = res.json();
    expect(body.startLine).toBe(1);
    expect(body.endLine).toBe(body.totalLines);
    const onDisk = await readFile(path.join(TS_FIXTURE_REPO, "src", "lib", "strings.ts"), "utf8");
    expect(body.content.replace(/\r/g, "")).toBe(onDisk.replace(/\r/g, "").replace(/\n$/, ""));
  });

  it("rejects start greater than end", async () => {
    const res = await get(t, `/api/analyses/${id}/source?file=src/service.ts&start=9&end=7`);
    expect(res.statusCode).toBe(400);
  });
});
