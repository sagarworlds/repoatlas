import type { FileExtraction, RawReference } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { addBinding, type BindingMap } from "./bindings.ts";
import { makeContext, makeExtraction, makeIndex, sym } from "./fixture.ts";
import { applySuperTypes } from "./inheritance.ts";
import { resolveReference } from "./resolve-reference.ts";
import type { ResolveContext } from "./types.ts";

function call(over: Partial<RawReference> & { name: string }): RawReference {
  return { line: 5, kind: "call", ...over };
}

function ids(r: { targets: { nodeId: string }[] }): string[] {
  return r.targets.map((t) => t.nodeId);
}

function bindingMap(entries: Record<string, string>, via: "import" | "wildcard" = "import") {
  const map: BindingMap = new Map();
  for (const [name, nodeId] of Object.entries(entries)) {
    addBinding(map, name, { nodeId, confidence: "inferred", via });
  }
  return map;
}

/** extends references: `Sub` extends each name in `bases`. */
function withBases(ex: FileExtraction, sub: string, bases: string[]): FileExtraction {
  const refs: RawReference[] = bases.map((b) => ({
    line: 1,
    kind: "extends",
    name: b,
    fromLocalId: sub,
  }));
  return { ...ex, references: [...ex.references, ...refs] };
}

describe("step 1: self", () => {
  it("finds a method on the same class as inferred", () => {
    const ex = makeExtraction("a.py", { A: "class", "A.f": "method", "A.g": "method" });
    const ctx = makeContext([ex]);
    const r = resolveReference(
      ctx,
      ex,
      call({ name: "g", receiver: "self", receiverKind: "self", fromLocalId: "A.f" }),
    );
    expect(r.targets).toEqual([{ nodeId: sym("a.py", "A.g"), confidence: "inferred" }]);
    expect(r.step).toBe("self");
  });

  it("is exact for a direct hit only when exactSelf is set", () => {
    const ex = makeExtraction("a.py", { A: "class", "A.f": "method", "A.g": "method" });
    const ctx = makeContext([ex], {}, { exactSelf: true });
    const ref = call({ name: "g", receiver: "self", receiverKind: "self", fromLocalId: "A.f" });
    expect(resolveReference(ctx, ex, ref).targets[0]?.confidence).toBe("exact");
  });

  it("walks two inheritance levels across files", () => {
    const base = makeExtraction("base.py", { Root: "class", "Root.ping": "method" });
    const mid = withBases(makeExtraction("mid.py", { Mid: "class" }), "Mid", ["Root"]);
    const leaf = withBases(
      makeExtraction("leaf.py", { Leaf: "class", "Leaf.run": "method" }),
      "Leaf",
      ["Mid"],
    );
    const all = [base, mid, leaf];
    const ctx = makeContext(all, {
      "mid.py": bindingMap({ Root: sym("base.py", "Root") }),
      "leaf.py": bindingMap({ Mid: sym("mid.py", "Mid") }),
    });
    expect(applySuperTypes(ctx, all)).toBe(2);
    const r = resolveReference(
      ctx,
      leaf,
      call({ name: "ping", receiver: "self", receiverKind: "self", fromLocalId: "Leaf.run" }),
    );
    expect(ids(r)).toEqual([sym("base.py", "Root.ping")]);
    expect(r.targets[0]?.confidence).toBe("inferred");
  });

  it("follows left-to-right depth-first order with two bases", () => {
    const ex = withBases(
      makeExtraction("m.py", {
        L: "class",
        "L.hello": "method",
        R: "class",
        "R.hello": "method",
        C: "class",
        "C.run": "method",
      }),
      "C",
      ["L", "R"],
    );
    const ctx = makeContext([ex]);
    applySuperTypes(ctx, [ex]);
    const r = resolveReference(
      ctx,
      ex,
      call({ name: "hello", receiver: "self", receiverKind: "self", fromLocalId: "C.run" }),
    );
    expect(ids(r)).toEqual([sym("m.py", "L.hello")]);
  });

  it("survives a cycle in the inheritance graph", () => {
    const ex = withBases(
      withBases(makeExtraction("c.py", { A: "class", B: "class", "A.f": "method" }), "A", ["B"]),
      "B",
      ["A"],
    );
    const ctx = makeContext([ex]);
    applySuperTypes(ctx, [ex]);
    const r = resolveReference(
      ctx,
      ex,
      call({ name: "missing", receiver: "self", receiverKind: "self", fromLocalId: "A.f" }),
    );
    expect(r.unresolved).toBe(true);
  });

  it("caps the inheritance depth", () => {
    const spec: Record<string, "class" | "method"> = { "C0.f": "method" };
    for (let i = 0; i < 6; i++) spec[`C${i}`] = "class";
    spec.Top = "class";
    spec["Top.deep"] = "method";
    let ex = makeExtraction("d.py", spec);
    for (let i = 0; i < 5; i++) ex = withBases(ex, `C${i}`, [`C${i + 1}`]);
    ex = withBases(ex, "C5", ["Top"]);
    const call1 = call({
      name: "deep",
      receiver: "self",
      receiverKind: "self",
      fromLocalId: "C0.f",
    });
    const shallow = makeContext([ex], {}, { maxInheritanceDepth: 3 });
    applySuperTypes(shallow, [ex]);
    // Too deep for the hierarchy walk, so only the global name-match finds it.
    expect(resolveReference(shallow, ex, call1).step).toBe("name-match");
    const deep = makeContext([ex]);
    applySuperTypes(deep, [ex]);
    expect(ids(resolveReference(deep, ex, call1))).toEqual([sym("d.py", "Top.deep")]);
  });

  it("uses index super types without applySuperTypes", () => {
    const ex = makeExtraction("a.py", { P: "class", "P.m": "method", K: "class", "K.f": "method" });
    const ctx = makeContext([ex]);
    ctx.index.addSuperType?.(sym("a.py", "K"), sym("a.py", "P"));
    const r = resolveReference(
      ctx,
      ex,
      call({ name: "m", receiver: "self", receiverKind: "self", fromLocalId: "K.f" }),
    );
    expect(ids(r)).toEqual([sym("a.py", "P.m")]);
  });
});

describe("step 2: super", () => {
  it("looks only in super types", () => {
    const ex = withBases(
      makeExtraction("s.py", {
        Base: "class",
        "Base.save": "method",
        Kid: "class",
        "Kid.save": "method",
      }),
      "Kid",
      ["Base"],
    );
    const ctx = makeContext([ex]);
    applySuperTypes(ctx, [ex]);
    const r = resolveReference(
      ctx,
      ex,
      call({ name: "save", receiver: "super", receiverKind: "super", fromLocalId: "Kid.save" }),
    );
    expect(ids(r)).toEqual([sym("s.py", "Base.save")]);
    expect(r.step).toBe("super");
  });

  it("never name-matches a missed super call (it would match the caller itself)", () => {
    const ex = makeExtraction("s.py", { Kid: "class", "Kid.save": "method" });
    const ctx = makeContext([ex]);
    const r = resolveReference(
      ctx,
      ex,
      call({ name: "save", receiver: "super", receiverKind: "super", fromLocalId: "Kid.save" }),
    );
    expect(r.targets).toEqual([]);
    expect(r.unresolved).toBe(true);
  });
});

describe("step 3: unqualified calls", () => {
  it("prefers a local definition over an import (shadowing)", () => {
    const ex = makeExtraction("a.py", { helper: "function", main: "function" });
    const other = makeExtraction("u.py", { helper: "function" });
    const ctx = makeContext([ex, other], { "a.py": bindingMap({ helper: sym("u.py", "helper") }) });
    const r = resolveReference(ctx, ex, call({ name: "helper", fromLocalId: "main" }));
    expect(ids(r)).toEqual([sym("a.py", "helper")]);
    expect(r.step).toBe("local");
  });

  it("resolves a nested function before the module-level one", () => {
    const ex = makeExtraction("a.py", {
      run: "function",
      "run.inner": "function",
      inner: "function",
    });
    const ctx = makeContext([ex]);
    const r = resolveReference(ctx, ex, call({ name: "inner", fromLocalId: "run" }));
    expect(ids(r)).toEqual([sym("a.py", "run.inner")]);
  });

  it("does not see class members unqualified", () => {
    const ex = makeExtraction("a.py", { A: "class", "A.f": "method", "A.g": "method" });
    const ctx = makeContext([ex]);
    const r = resolveReference(ctx, ex, call({ name: "g", fromLocalId: "A.f" }));
    // Falls through to name-match, which finds the one method named g.
    expect(r.step).toBe("name-match");
  });

  it("uses the import binding", () => {
    const a = makeExtraction("a.py", { main: "function" });
    const u = makeExtraction("pkg/u.py", { helper: "function" });
    const ctx = makeContext([a, u], { "a.py": bindingMap({ h: sym("pkg/u.py", "helper") }) });
    const r = resolveReference(ctx, a, call({ name: "h", fromLocalId: "main" }));
    expect(ids(r)).toEqual([sym("pkg/u.py", "helper")]);
    expect(r.step).toBe("binding");
  });

  it("explicit names beat wildcards in the binding map", () => {
    const a = makeExtraction("a.py", { main: "function" });
    const x = makeExtraction("x.py", { f: "function" });
    const y = makeExtraction("y.py", { f: "function" });
    const map = bindingMap({ f: sym("y.py", "f") }, "import");
    addBinding(map, "f", { nodeId: sym("x.py", "f"), confidence: "inferred", via: "wildcard" });
    const ctx = makeContext([a, x, y], { "a.py": map });
    expect(ids(resolveReference(ctx, a, call({ name: "f", fromLocalId: "main" })))).toEqual([
      sym("y.py", "f"),
    ]);
  });

  it("an external binding yields no target", () => {
    const a = makeExtraction("a.py", { main: "function" });
    const ctx = makeContext([a], { "a.py": bindingMap({ array: "ext:pypi:numpy" }) });
    const r = resolveReference(ctx, a, call({ name: "array", fromLocalId: "main" }));
    expect(r).toMatchObject({ targets: [], unresolved: true, reason: "external" });
  });

  it("uses sameScopeLookup", () => {
    const a = makeExtraction("pkg/a.go", { main: "function" }, "python");
    const b = makeExtraction("pkg/b.go", { helper: "function" }, "python");
    const ctx = makeContext(
      [a, b],
      {},
      {
        sameScopeLookup: (name) =>
          name === "helper" ? [...(ctx.index.byShortName.get(name) ?? [])] : [],
      },
    );
    const r = resolveReference(ctx, a, call({ name: "helper", fromLocalId: "main" }));
    expect(ids(r)).toEqual([sym("pkg/b.go", "helper")]);
    expect(r.step).toBe("same-scope");
  });

  it("maps a class call to __init__ (also inherited)", () => {
    const ex = withBases(
      makeExtraction("m.py", {
        Base: "class",
        "Base.__init__": "method",
        Kid: "class",
        main: "function",
      }),
      "Kid",
      ["Base"],
    );
    const ctx = makeContext([ex]);
    applySuperTypes(ctx, [ex]);
    const r = resolveReference(ctx, ex, call({ name: "Kid", fromLocalId: "main" }));
    expect(ids(r)).toEqual([sym("m.py", "Base.__init__")]);
    expect(r.asReference).toBeUndefined();
  });

  it("returns the class as a reference when there is no constructor", () => {
    const ex = makeExtraction("m.py", { Plain: "class", main: "function" });
    const ctx = makeContext([ex]);
    const r = resolveReference(ctx, ex, call({ name: "Plain", fromLocalId: "main" }));
    expect(ids(r)).toEqual([sym("m.py", "Plain")]);
    expect(r.asReference).toBe(true);
  });

  it("returns the class as a reference when constructorNames is absent", () => {
    const ex = makeExtraction("m.py", { C: "class", "C.__init__": "method", main: "function" });
    const ctx = makeContext([ex], {}, { constructorNames: [] });
    const r = resolveReference(
      ctx,
      ex,
      call({ name: "C", kind: "instantiate", fromLocalId: "main" }),
    );
    expect(r.asReference).toBe(true);
  });
});

describe("step 4: import-bound receivers", () => {
  const util = makeExtraction("pkg/util.py", { helper: "function", Tool: "class" });
  const pkg = makeExtraction("pkg/__init__.py", {});
  const a = makeExtraction("a.py", { main: "function" });

  it("looks the name up in the bound file", () => {
    const ctx = makeContext([util, pkg, a], { "a.py": bindingMap({ util: "file:pkg/util.py" }) });
    const r = resolveReference(
      ctx,
      a,
      call({ name: "helper", receiver: "util", receiverKind: "identifier", fromLocalId: "main" }),
    );
    expect(ids(r)).toEqual([sym("pkg/util.py", "helper")]);
    expect(r.step).toBe("import-member");
  });

  it("follows one level of re-export through the target's bindings", () => {
    const ctx = makeContext([util, pkg, a], {
      "a.py": bindingMap({ pkg: "file:pkg/__init__.py" }),
      "pkg/__init__.py": bindingMap({ helper: sym("pkg/util.py", "helper") }),
    });
    const r = resolveReference(
      ctx,
      a,
      call({ name: "helper", receiver: "pkg", receiverKind: "identifier", fromLocalId: "main" }),
    );
    expect(ids(r)).toEqual([sym("pkg/util.py", "helper")]);
  });

  it("does not follow a second level of re-export", () => {
    const deep = makeExtraction("pkg/deep.py", { helper: "function" });
    const ctx = makeContext([util, pkg, a, deep], {
      "a.py": bindingMap({ pkg: "file:pkg/__init__.py" }),
      "pkg/__init__.py": bindingMap({ helper: "file:pkg/util.py" }),
    });
    const r = resolveReference(
      ctx,
      a,
      call({ name: "helper", receiver: "pkg", receiverKind: "identifier", fromLocalId: "main" }),
    );
    // File-bound re-export is not a symbol, so the lookup falls back to name-match.
    expect(r.step).toBe("name-match");
  });

  it("returns no target for an external receiver", () => {
    const ctx = makeContext([a], { "a.py": bindingMap({ np: "ext:pypi:numpy" }) });
    const r = resolveReference(
      ctx,
      a,
      call({ name: "array", receiver: "np", receiverKind: "identifier", fromLocalId: "main" }),
    );
    expect(r).toEqual({ targets: [], unresolved: true, reason: "external" });
  });

  it("resolves through a mod: binding and moduleToFiles", () => {
    const ctx = makeContext([util, a], { "a.py": bindingMap({ u: "mod:python:pkg.util" }) });
    ctx.index.moduleToFiles.set("pkg.util", ["pkg/util.py"]);
    const r = resolveReference(
      ctx,
      a,
      call({ name: "helper", receiver: "u", receiverKind: "identifier", fromLocalId: "main" }),
    );
    expect(ids(r)).toEqual([sym("pkg/util.py", "helper")]);
  });

  it("maps module.Class() to the constructor", () => {
    const m = makeExtraction("pkg/m.py", { K: "class", "K.__init__": "method" });
    const ctx = makeContext([m, a], { "a.py": bindingMap({ m: "file:pkg/m.py" }) });
    const r = resolveReference(
      ctx,
      a,
      call({ name: "K", receiver: "m", receiverKind: "identifier", fromLocalId: "main" }),
    );
    expect(ids(r)).toEqual([sym("pkg/m.py", "K.__init__")]);
  });
});

describe("step 5: static calls", () => {
  it("resolves Class.member for a same-file class including supertypes", () => {
    const ex = withBases(
      makeExtraction("a.py", {
        Base: "class",
        "Base.create": "method",
        User: "class",
        main: "function",
      }),
      "User",
      ["Base"],
    );
    const ctx = makeContext([ex]);
    applySuperTypes(ctx, [ex]);
    const r = resolveReference(
      ctx,
      ex,
      call({ name: "create", receiver: "User", receiverKind: "identifier", fromLocalId: "main" }),
    );
    expect(ids(r)).toEqual([sym("a.py", "Base.create")]);
    expect(r.step).toBe("static");
  });

  it("resolves an imported class receiver", () => {
    const m = makeExtraction("models.py", { User: "class", "User.create": "method" });
    const a = makeExtraction("a.py", { main: "function" });
    const ctx = makeContext([m, a], { "a.py": bindingMap({ User: sym("models.py", "User") }) });
    const r = resolveReference(
      ctx,
      a,
      call({ name: "create", receiver: "User", receiverKind: "identifier", fromLocalId: "main" }),
    );
    expect(ids(r)).toEqual([sym("models.py", "User.create")]);
  });
});

describe("step 6: receiverTypeHint", () => {
  const m = makeExtraction("models.py", { User: "class", "User.save": "method" });
  const a = makeExtraction("a.py", { main: "function" });

  it("resolves the hint through bindings then looks up the member", () => {
    const ctx = makeContext([m, a], { "a.py": bindingMap({ User: sym("models.py", "User") }) });
    const r = resolveReference(
      ctx,
      a,
      call({
        name: "save",
        receiver: "u",
        receiverKind: "identifier",
        receiverTypeHint: "User",
        fromLocalId: "main",
      }),
    );
    expect(ids(r)).toEqual([sym("models.py", "User.save")]);
    expect(r.step).toBe("type-hint");
  });

  it("accepts a dotted hint", () => {
    const ctx = makeContext([m, a], { "a.py": bindingMap({ models: "file:models.py" }) });
    const r = resolveReference(
      ctx,
      a,
      call({
        name: "save",
        receiver: "u",
        receiverKind: "identifier",
        receiverTypeHint: "models.User",
        fromLocalId: "main",
      }),
    );
    expect(ids(r)).toEqual([sym("models.py", "User.save")]);
  });

  it("an external hint type yields no target", () => {
    const ctx = makeContext([m, a], { "a.py": bindingMap({ Session: "ext:pypi:requests" }) });
    const r = resolveReference(
      ctx,
      a,
      call({
        name: "save",
        receiver: "s",
        receiverKind: "identifier",
        receiverTypeHint: "Session",
        fromLocalId: "main",
      }),
    );
    expect(r.reason).toBe("external");
    expect(r.targets).toEqual([]);
  });

  it("works for a member-chain receiver with a hint", () => {
    const ctx = makeContext([m, a], { "a.py": bindingMap({ User: sym("models.py", "User") }) });
    const r = resolveReference(
      ctx,
      a,
      call({
        name: "save",
        receiver: "x.y",
        receiverKind: "member-chain",
        receiverTypeHint: "User",
        fromLocalId: "main",
      }),
    );
    expect(ids(r)).toEqual([sym("models.py", "User.save")]);
  });
});

describe("step 7: name-match", () => {
  function ctxWith(
    names: string[],
    language: "python" | "go" = "python",
  ): [ResolveContext, FileExtraction] {
    const caller = makeExtraction("caller.py", { main: "function" });
    const files = names.map((_, i) =>
      makeExtraction(
        `f${i}.${language === "go" ? "go" : "py"}`,
        { [`K${i}`]: "class", [`K${i}.doIt`]: "method" },
        language,
      ),
    );
    return [makeContext([caller, ...files]), caller];
  }

  it("links 1 to 3 candidates with name-match confidence", () => {
    const [ctx, caller] = ctxWith(["a", "b"]);
    const r = resolveReference(
      ctx,
      caller,
      call({ name: "doIt", receiver: "thing", receiverKind: "identifier", fromLocalId: "main" }),
    );
    expect(r.targets).toHaveLength(2);
    expect(r.targets.every((t) => t.confidence === "name-match")).toBe(true);
  });

  it("is deterministic: targets are sorted by node id regardless of index order", () => {
    const [ctx, caller] = ctxWith(["a", "b", "c"]);
    const list = ctx.index.byShortName.get("doIt") ?? [];
    ctx.index.byShortName.set("doIt", [...list].reverse());
    const r = resolveReference(
      ctx,
      caller,
      call({ name: "doIt", receiver: "thing", receiverKind: "other", fromLocalId: "main" }),
    );
    const sorted = [...ids(r)].sort();
    expect(ids(r)).toEqual(sorted);
  });

  it("is ambiguous above three candidates", () => {
    const [ctx, caller] = ctxWith(["a", "b", "c", "d"]);
    const r = resolveReference(
      ctx,
      caller,
      call({ name: "doIt", receiver: "thing", receiverKind: "identifier", fromLocalId: "main" }),
    );
    expect(r).toMatchObject({ targets: [], unresolved: true, reason: "ambiguous" });
  });

  it("reports no-candidate for unknown names", () => {
    const [ctx, caller] = ctxWith(["a"]);
    const r = resolveReference(ctx, caller, call({ name: "nothing", fromLocalId: "main" }));
    expect(r.reason).toBe("no-candidate");
  });

  it("never name-matches stoplisted names, including extras", () => {
    const caller = makeExtraction("caller.py", { main: "function" });
    const other = makeExtraction("o.py", { O: "class", "O.get": "method", "O.custom": "method" });
    const ctx = makeContext([caller, other], {}, { stoplistExtra: ["custom"] });
    for (const name of ["get", "custom"]) {
      const r = resolveReference(
        ctx,
        caller,
        call({ name, receiver: "x", receiverKind: "identifier", fromLocalId: "main" }),
      );
      expect(r).toMatchObject({ targets: [], unresolved: true, reason: "no-candidate" });
    }
  });

  it("only matches symbols of the same language", () => {
    const caller = makeExtraction("caller.py", { main: "function" });
    const go = makeExtraction("x.go", { Foo: "class", "Foo.doIt": "method" }, "go");
    const ctx = makeContext([caller, go]);
    const r = resolveReference(
      ctx,
      caller,
      call({ name: "doIt", receiver: "x", receiverKind: "identifier", fromLocalId: "main" }),
    );
    expect(r.unresolved).toBe(true);
  });

  it("falls back to name-match when self lookup misses", () => {
    const a = makeExtraction("a.py", { A: "class", "A.f": "method" });
    const b = makeExtraction("b.py", { B: "class", "B.other": "method" });
    const ctx = makeContext([a, b]);
    const r = resolveReference(
      ctx,
      a,
      call({ name: "other", receiver: "self", receiverKind: "self", fromLocalId: "A.f" }),
    );
    expect(ids(r)).toEqual([sym("b.py", "B.other")]);
    expect(r.targets[0]?.confidence).toBe("name-match");
  });
});

describe("type references and misc", () => {
  it("type refs resolve like inheritance", () => {
    const m = makeExtraction("models.py", { User: "class" });
    const a = makeExtraction("a.py", { main: "function" });
    const ctx = makeContext([m, a], { "a.py": bindingMap({ User: sym("models.py", "User") }) });
    const r = resolveReference(ctx, a, {
      line: 2,
      kind: "type",
      name: "User",
      fromLocalId: "main",
    });
    expect(ids(r)).toEqual([sym("models.py", "User")]);
  });

  it("does not mutate the index or the extraction", () => {
    const a = makeExtraction("a.py", { main: "function" });
    const ctx = makeContext([a]);
    const before = JSON.stringify(a);
    resolveReference(ctx, a, call({ name: "zzz", fromLocalId: "main" }));
    expect(JSON.stringify(a)).toBe(before);
    expect(makeIndex([a]).byFile.size).toBe(1);
  });
});
