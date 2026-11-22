import type { RawReference } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { addBinding, type BindingMap, mergeBindingMaps } from "./bindings.ts";
import { summariseResolution, toEdges, toUnresolved } from "./edges.ts";
import { makeContext, makeExtraction, sym } from "./fixture.ts";
import { applySuperTypes } from "./inheritance.ts";
import { resolveTypeName } from "./type-name.ts";

describe("toEdges", () => {
  const ex = makeExtraction("a.py", { main: "function" });

  it("maps reference kinds to edge kinds", () => {
    const target = { targets: [{ nodeId: "sym:b.py#B", confidence: "inferred" as const }] };
    const kinds = (kind: RawReference["kind"]) =>
      toEdges(ex, { line: 3, kind, name: "B", fromLocalId: "main" }, target)[0]?.kind;
    expect(kinds("call")).toBe("calls");
    expect(kinds("instantiate")).toBe("calls");
    expect(kinds("extends")).toBe("extends");
    expect(kinds("implements")).toBe("implements");
    expect(kinds("type")).toBe("references");
  });

  it("uses references for a class called without a constructor", () => {
    const edges = toEdges(
      ex,
      { line: 3, kind: "call", name: "B", fromLocalId: "main" },
      { targets: [{ nodeId: "sym:b.py#B", confidence: "inferred" }], asReference: true },
    );
    expect(edges).toEqual([
      {
        src: sym("a.py", "main"),
        dst: "sym:b.py#B",
        kind: "references",
        confidence: "inferred",
        line: 3,
      },
    ]);
  });

  it("uses the file as source for top-level code and honours fromNodeId", () => {
    const resolved = { targets: [{ nodeId: "sym:b.py#f", confidence: "exact" as const }] };
    const ref: RawReference = { line: 1, kind: "call", name: "f" };
    expect(toEdges(ex, ref, resolved)[0]?.src).toBe("file:a.py");
    expect(toEdges(ex, ref, resolved, "sym:x#y")[0]?.src).toBe("sym:x#y");
  });

  it("emits one edge per name-match target and none when unresolved", () => {
    const ref: RawReference = { line: 1, kind: "call", name: "f" };
    const two = {
      targets: [
        { nodeId: "sym:a#f", confidence: "name-match" as const },
        { nodeId: "sym:b#f", confidence: "name-match" as const },
      ],
    };
    expect(toEdges(ex, ref, two)).toHaveLength(2);
    expect(toEdges(ex, ref, { targets: [], unresolved: true, reason: "ambiguous" })).toEqual([]);
  });

  it("builds unresolved entries", () => {
    expect(toUnresolved(ex, { line: 7, kind: "call", name: "zz" })).toEqual({
      file: "a.py",
      line: 7,
      name: "zz",
      kind: "call",
    });
  });
});

describe("summariseResolution", () => {
  it("counts resolved, unresolved and reasons", () => {
    const s = summariseResolution([
      { targets: [{ nodeId: "x", confidence: "exact" }] },
      { targets: [], unresolved: true, reason: "external" },
      { targets: [], unresolved: true, reason: "external" },
      { targets: [], unresolved: true, reason: "ambiguous" },
      { targets: [], unresolved: true },
    ]);
    expect(s).toEqual({
      total: 5,
      resolved: 1,
      unresolved: 4,
      byReason: { external: 2, ambiguous: 1, unknown: 1 },
    });
  });
});

describe("binding maps", () => {
  const make = (via: "import" | "wildcard", nodeId: string): BindingMap =>
    new Map([["x", { nodeId, confidence: "inferred", via }]]);

  it("wildcards never replace explicit names, in either merge order", () => {
    expect(mergeBindingMaps(make("import", "A"), make("wildcard", "B")).get("x")?.nodeId).toBe("A");
    expect(mergeBindingMaps(make("wildcard", "B"), make("import", "A")).get("x")?.nodeId).toBe("A");
  });

  it("later explicit bindings win and inputs are not mutated", () => {
    const base = make("import", "A");
    const merged = mergeBindingMaps(base, make("import", "C"));
    expect(merged.get("x")?.nodeId).toBe("C");
    expect(base.get("x")?.nodeId).toBe("A");
  });

  it("addBinding follows the same rule", () => {
    const map = make("import", "A");
    addBinding(map, "x", { nodeId: "W", confidence: "inferred", via: "wildcard" });
    expect(map.get("x")?.nodeId).toBe("A");
  });
});

describe("resolveTypeName and applySuperTypes", () => {
  it("prefers same file, then bindings, then name-match", () => {
    const local = makeExtraction("a.py", { Base: "class" });
    const other = makeExtraction("b.py", { Base: "class", Only: "class" });
    const ctx = makeContext([local, other], {
      "a.py": new Map([
        ["Base", { nodeId: sym("b.py", "Base"), confidence: "exact", via: "import" }],
      ]),
    });
    expect(resolveTypeName(ctx, local, "Base").targets[0]?.nodeId).toBe(sym("a.py", "Base"));
    const r = resolveTypeName(ctx, local, "Only");
    expect(r.targets).toEqual([{ nodeId: sym("b.py", "Only"), confidence: "name-match" }]);
  });

  it("resolves qualified bases through a module binding and flags externals", () => {
    const m = makeExtraction("pkg/m.py", { Base: "class" });
    const a = makeExtraction("a.py", { Kid: "class" });
    const ctx = makeContext([m, a], {
      "a.py": new Map([
        ["m", { nodeId: "file:pkg/m.py", confidence: "inferred", via: "import" }],
        ["np", { nodeId: "ext:pypi:numpy", confidence: "inferred", via: "import" }],
      ]),
    });
    expect(resolveTypeName(ctx, a, "Base", "m").targets[0]?.nodeId).toBe(sym("pkg/m.py", "Base"));
    expect(resolveTypeName(ctx, a, "np.ndarray").reason).toBe("external");
  });

  it("does not record name-match or external bases as super types", () => {
    const a = makeExtraction("a.py", { Kid: "class", Loose: "class" });
    const withRefs = {
      ...a,
      references: [
        { line: 1, kind: "extends" as const, name: "Loose", fromLocalId: "Kid" },
        { line: 1, kind: "extends" as const, name: "Missing", fromLocalId: "Kid" },
      ],
    };
    const ctx = makeContext([withRefs]);
    expect(applySuperTypes(ctx, [withRefs])).toBe(1);
    expect(ctx.index.superTypesOf(sym("a.py", "Kid"))).toEqual([sym("a.py", "Loose")]);
  });

  it("is idempotent", () => {
    const a = makeExtraction("a.py", { Kid: "class", Base: "class" });
    const ex = {
      ...a,
      references: [{ line: 1, kind: "extends" as const, name: "Base", fromLocalId: "Kid" }],
    };
    const ctx = makeContext([ex]);
    expect(applySuperTypes(ctx, [ex])).toBe(1);
    expect(applySuperTypes(ctx, [ex])).toBe(0);
  });
});
