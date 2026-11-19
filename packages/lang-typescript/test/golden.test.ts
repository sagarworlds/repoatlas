import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDirRepoView, type RepoFile, type RepoView } from "@repoatlas/plugin-api";
import {
  CONFIDENCE_RANK,
  type Confidence,
  type FileExtraction,
  fileId,
  type NodeKind,
  type NodeMeta,
  type ResolutionResult,
  symbolId,
} from "@repoatlas/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { typescriptPlugin } from "../src/index.ts";

// Resolve the fixture from this file's location, never from process.cwd().
const FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/typescript", import.meta.url));

interface Expected {
  mustContainNodes: { id: string; kind: NodeKind; meta?: NodeMeta }[];
  mustContainEdges: { src: string; dst: string; kind: string; minConfidence?: Confidence }[];
  mustNotContainEdges: { src: string; dst: string; kind: string }[];
  mustBeUnresolved: { file: string; name: string; kind: string }[];
  parseErrorFiles: string[];
  minResolutionRate: number;
}

function listAllFiles(repo: RepoView): RepoFile[] {
  const out: RepoFile[] = [];
  const walk = (dir: string): void => {
    for (const name of repo.list(dir)) {
      const path = dir === "" ? name : `${dir}/${name}`;
      if (repo.isDir(path)) walk(path);
      else out.push({ path, bytes: repo.readSync(path)?.length ?? 0 });
    }
  };
  walk("");
  return out;
}

let expected: Expected;
let extractions: FileExtraction[];
let resolution: ResolutionResult;
const nodeKinds = new Map<string, string>();
const nodeMeta = new Map<string, NodeMeta | undefined>();

beforeAll(async () => {
  expected = JSON.parse(readFileSync(`${FIXTURE_DIR}/expected-edges.json`, "utf8")) as Expected;
  const repo = createDirRepoView(`${FIXTURE_DIR}/repo`);
  const allFiles = listAllFiles(repo);
  const files = typescriptPlugin.detect(allFiles);
  const ctx = { files, allFiles, repo };
  const info = (await typescriptPlugin.prepare?.(ctx)) ?? {};
  const result = await typescriptPlugin.analyzeProject?.(ctx, info);
  if (!result) throw new Error("typescript plugin must provide analyzeProject");
  extractions = result.extractions;
  resolution = result.resolution;

  for (const f of allFiles) nodeKinds.set(fileId(f.path), "file");
  for (const e of extractions) {
    for (const d of e.definitions) {
      const id = symbolId(e.file, d.localId);
      nodeKinds.set(id, d.kind);
      nodeMeta.set(id, d.meta);
    }
  }
  for (const x of resolution.externals) nodeKinds.set(x.id, x.kind);
});

const allEdges = (): ResolutionResult["edges"] => [...resolution.imports, ...resolution.edges];

describe("typescript fixture golden test", () => {
  it("contains all expected nodes", () => {
    for (const n of expected.mustContainNodes) {
      expect(nodeKinds.get(n.id), n.id).toBe(n.kind);
      for (const [key, value] of Object.entries(n.meta ?? {})) {
        expect(nodeMeta.get(n.id)?.[key], `${n.id} meta.${key}`).toBe(value);
      }
    }
  });

  it("contains all expected edges with enough confidence", () => {
    for (const want of expected.mustContainEdges) {
      const hit = allEdges().find(
        (e) => e.src === want.src && e.dst === want.dst && e.kind === want.kind,
      );
      expect(hit, `${want.kind} ${want.src} -> ${want.dst}`).toBeDefined();
      if (hit && want.minConfidence) {
        expect(CONFIDENCE_RANK[hit.confidence]).toBeGreaterThanOrEqual(
          CONFIDENCE_RANK[want.minConfidence],
        );
      }
    }
  });

  it("contains none of the forbidden edges", () => {
    for (const bad of expected.mustNotContainEdges) {
      const hit = allEdges().find(
        (e) => e.src === bad.src && e.dst === bad.dst && e.kind === bad.kind,
      );
      expect(hit, `${bad.kind} ${bad.src} -> ${bad.dst}`).toBeUndefined();
    }
  });

  it("records ambiguous calls as unresolved without an edge", () => {
    for (const want of expected.mustBeUnresolved) {
      expect(
        resolution.unresolved.some(
          (u) => u.file === want.file && u.name === want.name && u.kind === want.kind,
        ),
        `${want.file} ${want.name}`,
      ).toBe(true);
    }
  });

  it("reaches the minimum resolution rate", () => {
    const resolvedCalls = resolution.edges.filter((e) => e.kind === "calls").length;
    const unresolvedCalls = resolution.unresolved.filter((u) => u.kind === "call").length;
    const rate = resolvedCalls / (resolvedCalls + unresolvedCalls);
    expect(rate).toBeGreaterThanOrEqual(expected.minResolutionRate);
  });

  it("never emits an edge whose endpoints are not known nodes", () => {
    for (const e of allEdges()) {
      expect(nodeKinds.has(e.src), `src ${e.src}`).toBe(true);
      expect(nodeKinds.has(e.dst), `dst ${e.dst}`).toBe(true);
    }
  });

  it("counts parse errors but still extracts definitions from the broken file", () => {
    for (const path of expected.parseErrorFiles) {
      const extraction = extractions.find((e) => e.file === path);
      expect(extraction?.parseErrors, path).toBeGreaterThan(0);
      expect(extraction?.definitions.length, path).toBeGreaterThan(0);
    }
    const clean = extractions.filter((e) => !expected.parseErrorFiles.includes(e.file));
    expect(clean.every((e) => e.parseErrors === 0)).toBe(true);
  });

  it("marks definitions in test files with meta.isTest only", () => {
    const test = extractions.find((e) => e.file === "src/user.test.ts");
    expect(test?.definitions.every((d) => d.meta?.isTest === true)).toBe(true);
    const other = extractions.find((e) => e.file === "src/service.ts");
    expect(other?.definitions.some((d) => d.meta?.isTest === true)).toBe(false);
  });

  it("emits one imports edge per (file, external) and records node builtins in meta", () => {
    const toLodash = resolution.imports.filter((e) => e.dst === "ext:npm:lodash");
    expect(toLodash).toHaveLength(1);
    const builtin = resolution.imports.find((e) => e.dst === "ext:node:builtins");
    expect(builtin?.meta?.package).toBe("node:fs");
  });

  it("is deterministic across runs", async () => {
    const repo = createDirRepoView(`${FIXTURE_DIR}/repo`);
    const allFiles = listAllFiles(repo);
    const files = typescriptPlugin.detect(allFiles);
    const ctx = { files, allFiles, repo };
    const again = await typescriptPlugin.analyzeProject?.(
      ctx,
      (await typescriptPlugin.prepare?.(ctx)) ?? {},
    );
    expect(again?.resolution).toEqual(resolution);
  });
});
