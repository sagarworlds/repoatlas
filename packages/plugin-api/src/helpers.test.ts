import type { GraphNode } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { looksLikeTestPath, nameMatchCandidates } from "./helpers.ts";
import { isStoplisted } from "./stoplist.ts";
import type { SymbolIndex } from "./types.ts";

function indexOf(nodes: GraphNode[]): SymbolIndex {
  const byShortName = new Map<string, GraphNode[]>();
  for (const n of nodes) byShortName.set(n.name, [...(byShortName.get(n.name) ?? []), n]);
  return {
    byId: new Map(nodes.map((n) => [n.id, n])),
    byFile: new Map(),
    byQualifiedName: new Map(),
    byShortName,
    membersOf: () => [],
    superTypesOf: () => [],
    moduleToFiles: new Map(),
  };
}

const fn = (
  id: string,
  name: string,
  kind: GraphNode["kind"],
  language: GraphNode["language"],
): GraphNode => ({
  id,
  kind,
  name,
  language,
});

describe("nameMatchCandidates", () => {
  it("returns 1-3 same-language candidates", () => {
    const idx = indexOf([
      fn("sym:a.ts#save", "save", "function", "typescript"),
      fn("sym:b.py#save", "save", "function", "python"),
    ]);
    expect(nameMatchCandidates(idx, "save", "typescript", false).map((n) => n.id)).toEqual([
      "sym:a.ts#save",
    ]);
  });

  it("returns nothing for more than 3 candidates", () => {
    const idx = indexOf(
      [1, 2, 3, 4].map((i) => fn(`sym:f${i}.ts#save`, "save", "function", "typescript")),
    );
    expect(nameMatchCandidates(idx, "save", "typescript", false)).toEqual([]);
  });

  it("never matches stoplisted names", () => {
    const idx = indexOf([fn("sym:a.ts#get", "get", "function", "typescript")]);
    expect(nameMatchCandidates(idx, "get", "typescript", false)).toEqual([]);
  });

  it("prefers methods when a receiver exists", () => {
    const idx = indexOf([
      fn("sym:a.ts#save", "save", "function", "typescript"),
      fn("sym:a.ts#U.save", "save", "method", "typescript"),
    ]);
    expect(nameMatchCandidates(idx, "save", "typescript", true).map((n) => n.kind)).toEqual([
      "method",
    ]);
  });
});

describe("stoplist and test paths", () => {
  it("honours per-language additions", () => {
    expect(isStoplisted("foo")).toBe(false);
    expect(isStoplisted("foo", ["foo"])).toBe(true);
  });
  it("detects test paths", () => {
    expect(looksLikeTestPath("src/a.test.ts")).toBe(true);
    expect(looksLikeTestPath("tests/x.py")).toBe(true);
    expect(looksLikeTestPath("src/app.ts")).toBe(false);
  });
});
