import { readFileSync } from "node:fs";
import { CONFIDENCE_RANK, type Confidence, type NodeKind, type NodeMeta } from "@repoatlas/schema";
import { expect } from "vitest";
import type { PipelineResult } from "../src/index.ts";

/** Shape of fixtures/<lang>/expected-edges.json (docs/TESTING.md section 2, plus a few extras). */
export interface ExpectedGraph {
  mustContainNodes: { id: string; kind: NodeKind; meta?: NodeMeta }[];
  mustContainEdges: { src: string; dst: string; kind: string; minConfidence?: Confidence }[];
  mustNotContainEdges: { src: string; dst: string; kind: string }[];
  mustBeUnresolved: { file: string; name: string; kind: string }[];
  parseErrorFiles: string[];
  minResolutionRate: number;
  /** Multi-language fixtures: languages that must appear in `stats.languages`. */
  expectLanguages?: string[];
  /** Multi-language fixtures: no edge may connect files of two different languages. */
  noCrossLanguageEdges?: boolean;
}

export function loadExpected(path: string): ExpectedGraph {
  return JSON.parse(readFileSync(path, "utf8")) as ExpectedGraph;
}

/**
 * Golden assertions by containment: the result may have more nodes and edges than
 * expected, but never fewer, and never a forbidden edge. Reusable for every language
 * fixture (each language adds its own expected-edges.json).
 */
export function assertGolden(expected: ExpectedGraph, result: PipelineResult): void {
  const nodes = new Map(result.nodes.map((n) => [n.id, n]));

  for (const want of expected.mustContainNodes) {
    const node = nodes.get(want.id);
    expect(node, `node ${want.id}`).toBeDefined();
    expect(node?.kind, `kind of ${want.id}`).toBe(want.kind);
    for (const [key, value] of Object.entries(want.meta ?? {})) {
      expect(node?.meta?.[key], `${want.id} meta.${key}`).toBe(value);
    }
  }

  for (const want of expected.mustContainEdges) {
    const hit = result.edges.find(
      (e) => e.src === want.src && e.dst === want.dst && e.kind === want.kind,
    );
    expect(hit, `${want.kind} ${want.src} -> ${want.dst}`).toBeDefined();
    if (hit && want.minConfidence) {
      expect(
        CONFIDENCE_RANK[hit.confidence],
        `confidence of ${want.kind} ${want.src} -> ${want.dst}`,
      ).toBeGreaterThanOrEqual(CONFIDENCE_RANK[want.minConfidence]);
    }
  }

  for (const bad of expected.mustNotContainEdges) {
    const hit = result.edges.find(
      (e) => e.src === bad.src && e.dst === bad.dst && e.kind === bad.kind,
    );
    expect(hit, `forbidden ${bad.kind} ${bad.src} -> ${bad.dst}`).toBeUndefined();
  }

  for (const want of expected.mustBeUnresolved) {
    const hit = result.unresolved.some(
      (u) => u.file === want.file && u.name === want.name && u.kind === want.kind,
    );
    expect(hit, `unresolved ${want.file} ${want.name}`).toBe(true);
  }

  for (const path of expected.parseErrorFiles) {
    const meta = nodes.get(`file:${path}`)?.meta;
    expect(Number(meta?.parseErrors ?? 0), `parse errors of ${path}`).toBeGreaterThan(0);
  }
  expect(result.stats.parseErrorFiles).toBe(expected.parseErrorFiles.length);

  if (expected.expectLanguages) {
    expect(Object.keys(result.stats.languages).sort()).toEqual(
      [...expected.expectLanguages].sort(),
    );
  }
  if (expected.noCrossLanguageEdges) assertNoCrossLanguageEdges(result);

  const { resolved, unresolved } = result.stats.references;
  const rate = resolved + unresolved === 0 ? 1 : resolved / (resolved + unresolved);
  expect(rate).toBeGreaterThanOrEqual(expected.minResolutionRate);
}

/** Languages of the files an edge connects (external and repo nodes have none). */
function assertNoCrossLanguageEdges(result: PipelineResult): void {
  const languageOfNode = new Map<string, string>();
  for (const n of result.nodes) {
    if (n.language !== undefined) languageOfNode.set(n.id, n.language);
  }
  for (const e of result.edges) {
    if (e.kind === "contains") continue;
    const a = languageOfNode.get(e.src);
    const b = languageOfNode.get(e.dst);
    if (a !== undefined && b !== undefined) {
      expect(a, `${e.kind} ${e.src} -> ${e.dst}`).toBe(b);
    }
  }
}
