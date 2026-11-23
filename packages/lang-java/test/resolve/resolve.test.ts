import { describe, expect, it } from "vitest";
import { extraction, run, show, sym } from "./helpers.ts";

const m = (params: number, more: { varargs?: boolean; isStatic?: boolean } = {}) =>
  ({ kind: "method", params, ...more }) as const;

describe("inheritance and member lookup", () => {
  const base = extraction("p/Base.java", {
    pkg: "p",
    defs: { Base: "class", "Base.hello": m(0) },
  });
  const mid = extraction("q/Mid.java", {
    pkg: "q",
    defs: { Mid: "class" },
    imports: [{ specifier: "p.Base", kind: "module" }],
    refs: [{ kind: "extends", name: "Base", fromLocalId: "Mid" }],
  });
  const leaf = extraction("r/Leaf.java", {
    pkg: "r",
    defs: {
      Leaf: "class",
      "Leaf.go": m(0),
      "Leaf.Leaf": { kind: "method", params: 0, ctor: true },
    },
    imports: [{ specifier: "q.Mid", kind: "module" }],
    refs: [
      { kind: "extends", name: "Mid", fromLocalId: "Leaf" },
      { kind: "call", name: "hello", argCount: 0, fromLocalId: "Leaf.go" },
      {
        kind: "call",
        name: "hello",
        receiver: "this",
        receiverKind: "self",
        argCount: 0,
        fromLocalId: "Leaf.go",
      },
      {
        kind: "call",
        name: "hello",
        receiver: "super",
        receiverKind: "super",
        argCount: 0,
        fromLocalId: "Leaf.go",
      },
    ],
  });

  it("finds a member inherited through two levels across packages", async () => {
    const { result, summary } = await run([leaf, mid, base]);
    const calls = show(result.edges, "calls");
    const target = `sym:${base.file}#Base.hello`;
    expect(calls).toEqual([
      `sym:${leaf.file}#Leaf.go -> ${target} (inferred)`,
      `sym:${leaf.file}#Leaf.go -> ${target} (inferred)`,
      `sym:${leaf.file}#Leaf.go -> ${target} (inferred)`,
    ]);
    expect(show(result.edges, "extends")).toEqual([
      `sym:${mid.file}#Mid -> sym:${base.file}#Base (inferred)`,
      `sym:${leaf.file}#Leaf -> sym:${mid.file}#Mid (inferred)`,
    ]);
    expect(summary.unresolved).toBe(0);
  });

  it("finds an interface default method and keeps interface-typed receivers on the interface", async () => {
    const shape = extraction("p/Shape.java", {
      pkg: "p",
      defs: { Shape: "interface", "Shape.area": m(0), "Shape.describe": m(0) },
    });
    const circle = extraction("p/Circle.java", {
      pkg: "p",
      defs: { Circle: "class", "Circle.area": m(0), "Circle.show": m(0) },
      refs: [
        { kind: "implements", name: "Shape", fromLocalId: "Circle" },
        { kind: "call", name: "describe", argCount: 0, fromLocalId: "Circle.show" },
      ],
    });
    const user = extraction("p/User.java", {
      pkg: "p",
      defs: { User: "class", "User.use": m(1) },
      refs: [
        {
          kind: "call",
          name: "area",
          receiver: "s",
          argCount: 0,
          receiverTypeHint: "Shape",
          fromLocalId: "User.use",
        },
      ],
    });
    const { result } = await run([shape, circle, user]);
    expect(show(result.edges, "calls")).toEqual([
      `sym:${circle.file}#Circle.show -> sym:${shape.file}#Shape.describe (inferred)`,
      `sym:${user.file}#User.use -> sym:${shape.file}#Shape.area (inferred)`,
    ]);
    expect(show(result.edges, "implements")).toEqual([
      `sym:${circle.file}#Circle -> sym:${shape.file}#Shape (inferred)`,
    ]);
  });

  it("an overriding subclass method hides the base method", async () => {
    const a = extraction("p/A.java", { pkg: "p", defs: { A: "class", "A.f": m(0) } });
    const b = extraction("p/B.java", {
      pkg: "p",
      defs: { B: "class", "B.f": m(0), "B.g": m(0) },
      refs: [
        { kind: "extends", name: "A", fromLocalId: "B" },
        { kind: "call", name: "f", argCount: 0, fromLocalId: "B.g" },
      ],
    });
    const { result } = await run([a, b]);
    expect(show(result.edges, "calls")).toEqual([
      `sym:${b.file}#B.g -> sym:${b.file}#B.f (inferred)`,
    ]);
  });

  it("misses on classes with external super types are silent, not unresolved", async () => {
    const err = extraction("p/MyError.java", {
      pkg: "p",
      defs: { MyError: "class", "MyError.show": m(0) },
      refs: [
        { kind: "extends", name: "Exception", fromLocalId: "MyError" },
        { kind: "call", name: "getMessage", argCount: 0, fromLocalId: "MyError.show" },
        {
          kind: "call",
          name: "addSuppressed",
          receiver: "this",
          receiverKind: "self",
          argCount: 1,
          fromLocalId: "MyError.show",
        },
        { kind: "call", name: "toString", argCount: 0, fromLocalId: "MyError.show" },
      ],
    });
    const { result, summary } = await run([err]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(summary.unresolved).toBe(4); // the summary counts raw misses (incl. `extends Exception`); the report filters externals
  });

  it("a missing member of a fully known class is unresolved and never name-matched", async () => {
    const a = extraction("p/A.java", { pkg: "p", defs: { A: "class", "A.f": m(0) } });
    const b = extraction("p/B.java", {
      pkg: "p",
      defs: { B: "class", "B.g": m(0) },
      refs: [{ kind: "call", name: "f", argCount: 0, fromLocalId: "B.g" }],
    });
    const { result } = await run([a, b]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual([{ file: b.file, line: 100, name: "f", kind: "call" }]);
  });

  it("calls from an inner class reach the outer class members", async () => {
    const outer = extraction("p/Outer.java", {
      pkg: "p",
      defs: {
        Outer: "class",
        "Outer.helper": m(0),
        "Outer.Inner": "class",
        "Outer.Inner.work": m(0),
      },
      refs: [
        { kind: "call", name: "helper", argCount: 0, fromLocalId: "Outer.Inner.work" },
        {
          kind: "call",
          name: "helper",
          receiver: "Outer.this",
          receiverKind: "member-chain",
          argCount: 0,
          fromLocalId: "Outer.Inner.work",
        },
      ],
    });
    const { result } = await run([outer]);
    const t = `sym:${outer.file}#Outer.helper`;
    expect(show(result.edges, "calls")).toEqual([
      `sym:${outer.file}#Outer.Inner.work -> ${t} (inferred)`,
      `sym:${outer.file}#Outer.Inner.work -> ${t} (inferred)`,
    ]);
  });

  it("resolves nested type names inside the outer class and through inheritance", async () => {
    const outer = extraction("p/Outer.java", {
      pkg: "p",
      defs: { Outer: "class", "Outer.Inner": "class", "Outer.use": m(0) },
      refs: [{ kind: "type", name: "Inner", fromLocalId: "Outer.use" }],
    });
    const holder = extraction("q/Holder.java", {
      pkg: "q",
      defs: { Holder: "class", "Holder.use": m(0) },
      imports: [{ specifier: "p.Outer", kind: "module" }],
      refs: [
        { kind: "extends", name: "Outer", fromLocalId: "Holder" },
        { kind: "type", name: "Inner", fromLocalId: "Holder.use" },
        { kind: "type", name: "Inner", receiver: "Outer", fromLocalId: "Holder.use" },
      ],
    });
    const { result } = await run([outer, holder]);
    const inner = `sym:${outer.file}#Outer.Inner`;
    expect(show(result.edges, "references")).toEqual([
      `sym:${outer.file}#Outer.use -> ${inner} (inferred)`,
      `sym:${holder.file}#Holder.use -> ${inner} (inferred)`,
      `sym:${holder.file}#Holder.use -> ${inner} (inferred)`,
    ]);
  });

  it("a class cycle in extends does not hang", async () => {
    const a = extraction("p/A.java", {
      pkg: "p",
      defs: { A: "class", "A.f": m(0) },
      refs: [
        { kind: "extends", name: "B", fromLocalId: "A" },
        {
          kind: "call",
          name: "nothing",
          receiver: "this",
          receiverKind: "self",
          argCount: 0,
          fromLocalId: "A.f",
        },
      ],
    });
    const b = extraction("p/B.java", {
      pkg: "p",
      defs: { B: "class" },
      refs: [{ kind: "extends", name: "A", fromLocalId: "B" }],
    });
    const { result } = await run([a, b]);
    expect(result.unresolved).toEqual([{ file: a.file, line: 101, name: "nothing", kind: "call" }]);
  });
});

describe("overloads", () => {
  const svc = extraction("p/Svc.java", {
    pkg: "p",
    defs: {
      Svc: "class",
      "Svc.find": m(1),
      "Svc.find@20": m(2),
      "Svc.log": m(1, { varargs: true }),
      "Svc.pick": m(1),
      "Svc.pick@30": m(1),
      "Svc.many": m(1),
      "Svc.many@40": m(1),
      "Svc.many@41": m(1),
      "Svc.many@42": m(1),
      "Svc.run": m(0),
    },
  });
  const call = (name: string, argCount: number | undefined) =>
    extraction("p/Caller.java", {
      pkg: "p",
      defs: { Caller: "class", "Caller.go": m(0) },
      refs: [
        {
          kind: "call",
          name,
          receiver: "svc",
          argCount,
          receiverTypeHint: "Svc",
          fromLocalId: "Caller.go",
        },
      ],
    });

  it("picks by argument count", async () => {
    const one = await run([svc, call("find", 1)]);
    expect(show(one.result.edges)).toEqual([
      `sym:p/Caller.java#Caller.go -> sym:${svc.file}#Svc.find (inferred)`,
    ]);
    const two = await run([svc, call("find", 2)]);
    expect(show(two.result.edges)).toEqual([
      `sym:p/Caller.java#Caller.go -> sym:${svc.file}#Svc.find@20 (inferred)`,
    ]);
  });

  it("accepts any count at or above the fixed parameters of a varargs method", async () => {
    for (const n of [0, 1, 5]) {
      const { result } = await run([svc, call("log", n)]);
      expect(show(result.edges)).toEqual([
        `sym:p/Caller.java#Caller.go -> sym:${svc.file}#Svc.log (inferred)`,
      ]);
    }
  });

  it("same-arity overloads become name-match edges to every candidate", async () => {
    const { result, summary } = await run([svc, call("pick", 1)]);
    expect(show(result.edges)).toEqual([
      `sym:p/Caller.java#Caller.go -> sym:${svc.file}#Svc.pick (name-match)`,
      `sym:p/Caller.java#Caller.go -> sym:${svc.file}#Svc.pick@30 (name-match)`,
    ]);
    expect(summary.unresolved).toBe(0);
  });

  it("more than three ambiguous overloads are unresolved", async () => {
    const { result } = await run([svc, call("many", 1)]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
  });

  it("a wrong argument count falls back to the declared overloads as name-match", async () => {
    const { result } = await run([svc, call("run", 3)]);
    expect(show(result.edges)).toEqual([
      `sym:p/Caller.java#Caller.go -> sym:${svc.file}#Svc.run (name-match)`,
    ]);
  });

  it("a method reference (no argument count) with one candidate resolves", async () => {
    const { result } = await run([svc, call("run", undefined)]);
    expect(show(result.edges)).toEqual([
      `sym:p/Caller.java#Caller.go -> sym:${svc.file}#Svc.run (inferred)`,
    ]);
  });
});

describe("constructors", () => {
  const user = extraction("p/User.java", {
    pkg: "p",
    defs: {
      User: "class",
      "User.User": { kind: "method", params: 0, ctor: true },
      "User.User@9": { kind: "method", params: 2, ctor: true },
      "User.User@12": { kind: "method", params: 3, ctor: true },
      "User.User@13": { kind: "method", params: 3, ctor: true },
    },
  });
  const make = (argCount: number) =>
    extraction("p/Make.java", {
      pkg: "p",
      defs: { Make: "class", "Make.go": m(0) },
      refs: [{ kind: "instantiate", name: "User", argCount, fromLocalId: "Make.go" }],
    });

  it("new Foo(args) calls the constructor with that arity", async () => {
    const { result } = await run([user, make(2)]);
    expect(show(result.edges, "calls")).toEqual([
      `sym:p/Make.java#Make.go -> sym:${user.file}#User.User@9 (inferred)`,
    ]);
    const zero = await run([user, make(0)]);
    expect(show(zero.result.edges, "calls")).toEqual([
      `sym:p/Make.java#Make.go -> sym:${user.file}#User.User (inferred)`,
    ]);
  });

  it("falls back to a references edge when the arity is ambiguous or no constructor exists", async () => {
    for (const n of [3, 7]) {
      const { result } = await run([user, make(n)]);
      expect(show(result.edges)).toEqual([
        `sym:p/Make.java#Make.go -> sym:${user.file}#User (inferred)`,
      ]);
      expect(result.edges[0]?.kind).toBe("references");
    }
    const bare = extraction("p/Bare.java", { pkg: "p", defs: { Bare: "class" } });
    const caller = extraction("p/Caller.java", {
      pkg: "p",
      defs: { Caller: "class", "Caller.go": m(0) },
      refs: [{ kind: "instantiate", name: "Bare", argCount: 0, fromLocalId: "Caller.go" }],
    });
    const { result } = await run([bare, caller]);
    expect(result.edges.map((e) => e.kind)).toEqual(["references"]);
  });

  it("resolves this(...) and super(...) chains by argument count", async () => {
    const child = extraction("p/Child.java", {
      pkg: "p",
      defs: {
        Child: "class",
        "Child.Child": { kind: "method", params: 0, ctor: true },
        "Child.Child@5": { kind: "method", params: 1, ctor: true },
      },
      refs: [
        { kind: "extends", name: "User", fromLocalId: "Child" },
        {
          kind: "call",
          name: "this",
          receiverKind: "self",
          argCount: 1,
          fromLocalId: "Child.Child",
        },
        {
          kind: "call",
          name: "super",
          receiverKind: "super",
          argCount: 2,
          fromLocalId: "Child.Child@5",
        },
      ],
    });
    const { result } = await run([user, child]);
    expect(show(result.edges, "calls")).toEqual([
      `sym:${child.file}#Child.Child -> sym:${child.file}#Child.Child@5 (inferred)`,
      `sym:${child.file}#Child.Child@5 -> sym:${user.file}#User.User@9 (inferred)`,
    ]);
  });

  it("super(...) to an external super class is silent", async () => {
    const ex = extraction("p/MyEx.java", {
      pkg: "p",
      defs: { MyEx: "class", "MyEx.MyEx": { kind: "method", params: 1, ctor: true } },
      refs: [
        { kind: "extends", name: "RuntimeException", fromLocalId: "MyEx" },
        {
          kind: "call",
          name: "super",
          receiverKind: "super",
          argCount: 1,
          fromLocalId: "MyEx.MyEx",
        },
      ],
    });
    const { result } = await run([ex]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});

describe("receivers", () => {
  const repo = extraction("p/Repo.java", {
    pkg: "p",
    defs: { Repo: "interface", "Repo.save": m(1), "Repo.load": m(1) },
  });
  const util = extraction("p/Util.java", {
    pkg: "p",
    defs: { Util: "class", "Util.twice": m(1, { isStatic: true }) },
  });

  it("uses the receiver type hint (field, local or parameter) and static Type.call()", async () => {
    const svc = extraction("p/Svc.java", {
      pkg: "p",
      defs: { Svc: "class", "Svc.go": m(0) },
      refs: [
        {
          kind: "call",
          name: "save",
          receiver: "repo",
          argCount: 1,
          receiverTypeHint: "Repo",
          fromLocalId: "Svc.go",
        },
        { kind: "call", name: "twice", receiver: "Util", argCount: 1, fromLocalId: "Svc.go" },
        {
          kind: "call",
          name: "twice",
          receiver: "p.Util",
          receiverKind: "member-chain",
          argCount: 1,
          fromLocalId: "Svc.go",
        },
      ],
    });
    const { result } = await run([repo, util, svc]);
    expect(show(result.edges, "calls")).toEqual([
      `sym:${svc.file}#Svc.go -> sym:${repo.file}#Repo.save (inferred)`,
      `sym:${svc.file}#Svc.go -> sym:${util.file}#Util.twice (inferred)`,
      `sym:${svc.file}#Svc.go -> sym:${util.file}#Util.twice (inferred)`,
    ]);
  });

  it("calls on external types are silent; unknown receivers fall back to name-match", async () => {
    const svc = extraction("p/Svc.java", {
      pkg: "p",
      defs: { Svc: "class", "Svc.go": m(0) },
      imports: [{ specifier: "java.util.List", kind: "module" }],
      refs: [
        {
          kind: "call",
          name: "sort",
          receiver: "items",
          argCount: 0,
          receiverTypeHint: "List",
          fromLocalId: "Svc.go",
        },
        { kind: "call", name: "load", receiver: "thing", argCount: 1, fromLocalId: "Svc.go" },
        { kind: "call", name: "add", receiver: "thing", argCount: 1, fromLocalId: "Svc.go" },
        { kind: "call", name: "frobnicate", receiver: "thing", argCount: 1, fromLocalId: "Svc.go" },
      ],
    });
    const { result } = await run([repo, svc]);
    expect(show(result.edges)).toEqual([
      `sym:${svc.file}#Svc.go -> sym:${repo.file}#Repo.load (name-match)`,
    ]);
    // `add` is stoplisted (silent); `frobnicate` has no candidate (reported).
    expect(result.unresolved).toEqual([
      { file: svc.file, line: 103, name: "frobnicate", kind: "call" },
    ]);
  });

  it("a type parameter hint is silent", async () => {
    const svc = extraction("p/Box.java", {
      pkg: "p",
      defs: { Box: "class", "Box.go": m(0) },
      refs: [
        {
          kind: "call",
          name: "load",
          receiver: "item",
          argCount: 1,
          receiverTypeHint: "T",
          fromLocalId: "Box.go",
        },
      ],
    });
    const { result } = await run([repo, svc]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("enum, record and Lombok classes hide generated members", async () => {
    const color = extraction("p/Color.java", {
      pkg: "p",
      defs: { Color: { kind: "class", javaKind: "enum" } },
    });
    const point = extraction("p/Point.java", {
      pkg: "p",
      defs: { Point: { kind: "class", javaKind: "record" } },
    });
    const dto = extraction("p/Dto.java", {
      pkg: "p",
      defs: { Dto: { kind: "class", annotations: ["Data"] } },
    });
    const user = extraction("p/User.java", {
      pkg: "p",
      defs: { User: "class", "User.go": m(0) },
      refs: [
        { kind: "call", name: "values", receiver: "Color", argCount: 0, fromLocalId: "User.go" },
        {
          kind: "call",
          name: "x",
          receiver: "pt",
          argCount: 0,
          receiverTypeHint: "Point",
          fromLocalId: "User.go",
        },
        {
          kind: "call",
          name: "getName",
          receiver: "dto",
          argCount: 0,
          receiverTypeHint: "Dto",
          fromLocalId: "User.go",
        },
      ],
    });
    const { result } = await run([color, point, dto, user]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});

describe("references and determinism", () => {
  it("reports unresolved types, but not type variables or external wildcard names", async () => {
    const a = extraction("p/A.java", {
      pkg: "p",
      defs: { A: "class", "A.f": m(0) },
      refs: [
        { kind: "type", name: "Ghost", fromLocalId: "A.f" },
        { kind: "type", name: "T", fromLocalId: "A.f" },
      ],
    });
    const withWildcard = extraction("p/B.java", {
      pkg: "p",
      defs: { B: "class", "B.f": m(0) },
      imports: [{ specifier: "java.util", kind: "wildcard" }],
      refs: [{ kind: "instantiate", name: "ArrayList", argCount: 0, fromLocalId: "B.f" }],
    });
    const { result } = await run([a, withWildcard]);
    expect(result.unresolved).toEqual([{ file: a.file, line: 100, name: "Ghost", kind: "type" }]);
  });

  it("is deterministic for any input order", async () => {
    const a = extraction("p/A.java", {
      pkg: "p",
      defs: { A: "class", "A.f": m(0), "A.g": m(0) },
      imports: [{ specifier: "java.util.List", kind: "module" }],
      refs: [{ kind: "call", name: "g", argCount: 0, fromLocalId: "A.f" }],
    });
    const b = extraction("p/B.java", {
      pkg: "p",
      defs: { B: "class", "B.h": m(0) },
      refs: [
        { kind: "extends", name: "A", fromLocalId: "B" },
        { kind: "call", name: "f", argCount: 0, fromLocalId: "B.h" },
      ],
    });
    const c = extraction("q/C.java", {
      pkg: "q",
      defs: { C: "class" },
      imports: [{ specifier: "p", kind: "wildcard" }],
      refs: [{ kind: "extends", name: "B", fromLocalId: "C" }],
    });
    const first = (await run([a, b, c])).result;
    const second = (await run([c, a, b])).result;
    const third = (await run([b, c, a])).result;
    const norm = (r: typeof first) =>
      JSON.stringify({
        ...r,
        edges: [...r.edges].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)),
      });
    expect(norm(second)).toBe(norm(first));
    expect(norm(third)).toBe(norm(first));
    expect(first.imports).toEqual(second.imports);
  });

  it("works through javaResolve with the stored prepare info", async () => {
    const a = extraction("p/A.java", { pkg: "p", defs: { A: "class" } });
    const { resolve, result } = await run([a]);
    expect(await resolve()).toEqual(result);
  });

  it("symbol ids use the file path and the in-file name", () => {
    expect(sym("p/A.java", "A.f")).toBe("sym:p/A.java#A.f");
  });
});
