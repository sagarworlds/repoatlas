import { describe, expect, it } from "vitest";
import {
  type GraphEdge,
  GraphEdgeSchema,
  GraphNodeSchema,
  MAX_EDGE_LINES,
  mergeEdges,
  SCHEMA_VERSION,
} from "./graph.ts";
import { FileExtractionSchema } from "./plugin-output.ts";

describe("schemas", () => {
  it("has SCHEMA_VERSION 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("accepts a valid node and keeps namespaced meta keys", () => {
    const node = GraphNodeSchema.parse({
      id: "sym:a.py#A.b",
      kind: "method",
      name: "b",
      meta: { isStatic: true, "py.decorators": ["staticmethod"] },
    });
    expect(node.meta?.["py.decorators"]).toEqual(["staticmethod"]);
  });

  it("rejects unknown node kinds and over-long signatures", () => {
    expect(() => GraphNodeSchema.parse({ id: "x:", kind: "bogus", name: "x" })).toThrow();
    expect(() =>
      GraphNodeSchema.parse({ id: "x:", kind: "function", name: "x", signature: "s".repeat(301) }),
    ).toThrow();
  });

  it("rejects unknown confidence on edges", () => {
    expect(() =>
      GraphEdgeSchema.parse({ src: "a", dst: "b", kind: "calls", confidence: "maybe" }),
    ).toThrow();
  });

  it("validates a FileExtraction", () => {
    const ex = FileExtractionSchema.parse({
      file: "a.ts",
      language: "typescript",
      definitions: [
        { localId: "f", kind: "function", name: "f", span: { startLine: 1, endLine: 2 } },
      ],
      imports: [],
      references: [],
      parseErrors: 0,
    });
    expect(ex.definitions).toHaveLength(1);
  });
});

describe("mergeEdges", () => {
  const e = (over: Partial<GraphEdge>): GraphEdge => ({
    src: "a",
    dst: "b",
    kind: "calls",
    confidence: "name-match",
    ...over,
  });

  it("merges duplicates, counts calls, keeps first line and highest confidence", () => {
    const out = mergeEdges([
      e({ line: 5 }),
      e({ line: 9, confidence: "exact" }),
      e({ line: 12, confidence: "inferred" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.line).toBe(5);
    expect(out[0]?.confidence).toBe("exact");
    expect(out[0]?.meta?.callCount).toBe(3);
    expect(out[0]?.meta?.lines).toEqual([5, 9, 12]);
  });

  it("keeps different kinds and targets separate", () => {
    expect(mergeEdges([e({}), e({ kind: "references" }), e({ dst: "c" })])).toHaveLength(3);
  });

  it("caps stored lines", () => {
    const many = Array.from({ length: MAX_EDGE_LINES + 20 }, (_, i) => e({ line: i + 1 }));
    const out = mergeEdges(many);
    expect(out[0]?.meta?.lines).toHaveLength(MAX_EDGE_LINES);
    expect(out[0]?.meta?.callCount).toBe(MAX_EDGE_LINES + 20);
  });

  it("does not mutate its input", () => {
    const input = [e({ line: 1 }), e({ line: 2 })];
    mergeEdges(input);
    expect(input[0]?.meta).toBeUndefined();
  });
});
