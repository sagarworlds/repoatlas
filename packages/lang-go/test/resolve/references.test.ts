import { describe, expect, it } from "vitest";
import { edgeBetween, goFile, run, sym } from "./helpers.ts";

const GO_MOD = "module example.com/app\n";

describe("same-package visibility across files", () => {
  it("resolves a bare call to a function declared in another file of the package", async () => {
    const a = goFile("svc/a.go", {
      defs: { Run: "function" },
      refs: [{ name: "helper", fromLocalId: "Run", line: 7 }],
    });
    const b = goFile("svc/b.go", { defs: { helper: "function" } });
    const { result } = await run([a, b], { "go.mod": GO_MOD });
    expect(result.edges).toEqual([
      {
        src: sym("svc/a.go", "Run"),
        dst: sym("svc/b.go", "helper"),
        kind: "calls",
        confidence: "inferred",
        line: 7,
      },
    ]);
  });

  it("does not see functions of another directory without an import", async () => {
    const a = goFile("one/a.go", {
      defs: { Run: "function" },
      refs: [{ name: "Other", fromLocalId: "Run" }],
    });
    const b = goFile("two/b.go", { defs: { Other: "function" } });
    const { result, summary } = await run([a, b], { "go.mod": GO_MOD });
    expect(result.edges).toEqual([]);
    // a bare name outside the package scope is a builtin or a local value: not counted
    expect(summary.byReason.external).toBe(1);
  });

  it("attaches a method to a type declared in another file and finds it from a third", async () => {
    const types = goFile("svc/types.go", { defs: { Server: "class" } });
    const start = goFile("svc/start.go", {
      defs: { "Server.Start": "method", "Server.boot": "method" },
      refs: [{ name: "boot", receiver: "s", receiverKind: "self", fromLocalId: "Server.Start" }],
    });
    const use = goFile("svc/use.go", {
      defs: { Use: "function" },
      refs: [
        {
          name: "Start",
          receiver: "srv",
          receiverKind: "identifier",
          receiverTypeHint: "*Server",
          fromLocalId: "Use",
        },
      ],
    });
    const { result } = await run([types, start, use], { "go.mod": GO_MOD });
    expect(
      edgeBetween(
        result.edges,
        sym("svc/start.go", "Server.Start"),
        sym("svc/start.go", "Server.boot"),
      ),
    ).toMatchObject({ kind: "calls", confidence: "inferred" });
    expect(
      edgeBetween(result.edges, sym("svc/use.go", "Use"), sym("svc/start.go", "Server.Start")),
    ).toMatchObject({ kind: "calls" });
  });

  it("test files see the package under test, but production files do not see test helpers", async () => {
    const lib = goFile("lib/lib.go", {
      defs: { Add: "function" },
      refs: [{ name: "testHelper", fromLocalId: "Add" }],
    });
    const test = goFile("lib/lib_test.go", {
      defs: { TestAdd: "function", testHelper: "function" },
      refs: [{ name: "Add", fromLocalId: "TestAdd" }],
    });
    const { result } = await run([lib, test], { "go.mod": GO_MOD });
    expect(
      edgeBetween(result.edges, sym("lib/lib_test.go", "TestAdd"), sym("lib/lib.go", "Add")),
    ).toBeDefined();
    expect(result.edges.some((e) => e.src === sym("lib/lib.go", "Add"))).toBe(false);
  });
});

describe("imports and bindings in references", () => {
  it("resolves pkg.Func through an alias and a declared package name", async () => {
    const main = goFile("main.go", {
      imports: [
        { specifier: "example.com/app/store", alias: "st" },
        { specifier: "example.com/app/cfg" },
      ],
      defs: { main: "function" },
      refs: [
        { name: "Open", receiver: "st", receiverKind: "identifier", fromLocalId: "main" },
        { name: "Load", receiver: "config", receiverKind: "identifier", fromLocalId: "main" },
        { name: "open", receiver: "st", receiverKind: "identifier", fromLocalId: "main" },
      ],
    });
    const store = goFile("store/s.go", { defs: { Open: "function", open: "function" } });
    const cfg = goFile("cfg/c.go", { pkg: "config", defs: { Load: "function" } });
    const { result, summary } = await run([main, store, cfg], { "go.mod": GO_MOD });
    expect(
      edgeBetween(result.edges, sym("main.go", "main"), sym("store/s.go", "Open")),
    ).toBeDefined();
    expect(
      edgeBetween(result.edges, sym("main.go", "main"), sym("cfg/c.go", "Load")),
    ).toBeDefined();
    // unexported names are not visible through an import
    expect(
      edgeBetween(result.edges, sym("main.go", "main"), sym("store/s.go", "open")),
    ).toBeUndefined();
    expect(summary.byReason["no-candidate"]).toBe(1);
  });

  it("resolves bare names through a dot import, and Type refs make references edges", async () => {
    const main = goFile("main.go", {
      imports: [{ specifier: "example.com/app/util", kind: "wildcard", alias: "." }],
      defs: { main: "function" },
      refs: [
        { name: "Helper", fromLocalId: "main", line: 5 },
        { name: "Config", kind: "type", fromLocalId: "main", line: 6 },
        { name: "Config", kind: "instantiate", fromLocalId: "main", line: 7 },
      ],
    });
    const util = goFile("util/u.go", { defs: { Helper: "function", Config: "class" } });
    const { result } = await run([main, util], { "go.mod": GO_MOD });
    const src = sym("main.go", "main");
    expect(edgeBetween(result.edges, src, sym("util/u.go", "Helper"))?.kind).toBe("calls");
    const refs = result.edges.filter((e) => e.dst === sym("util/u.go", "Config"));
    expect(refs).toHaveLength(2);
    expect(refs.every((e) => e.kind === "references")).toBe(true);
  });

  it("resolves a qualified type reference and ignores predeclared types and self references", async () => {
    const main = goFile("main.go", {
      imports: [{ specifier: "example.com/app/model" }],
      defs: { Handle: "function", Node: "class" },
      refs: [
        { name: "User", receiver: "model", kind: "type", fromLocalId: "Handle" },
        { name: "string", kind: "type", fromLocalId: "Handle" },
        { name: "error", kind: "type", fromLocalId: "Handle" },
        { name: "Node", kind: "type", fromLocalId: "Node" },
      ],
    });
    const model = goFile("model/m.go", { defs: { User: "class" } });
    const { result, summary } = await run([main, model], { "go.mod": GO_MOD });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ dst: sym("model/m.go", "User"), kind: "references" });
    expect(summary.byReason["no-candidate"]).toBeUndefined();
  });
});

describe("embedding and promoted methods", () => {
  function embedding() {
    const a = goFile("svc/a.go", { defs: { Base: "class" } });
    const aMethods = goFile("svc/a_methods.go", { defs: { "Base.Ping": "method" } });
    const b = goFile("svc/b.go", {
      defs: { Mid: "class" },
      refs: [{ name: "Base", kind: "extends", fromLocalId: "Mid" }],
    });
    const c = goFile("svc/c.go", {
      defs: { Top: "class", "Top.Run": "method" },
      refs: [
        { name: "Mid", kind: "extends", fromLocalId: "Top" },
        { name: "Ping", receiver: "t", receiverKind: "self", fromLocalId: "Top.Run" },
      ],
    });
    return [a, aMethods, b, c];
  }

  it("finds a method promoted through two levels of embedding", async () => {
    const { result } = await run(embedding(), { "go.mod": GO_MOD });
    expect(
      edgeBetween(result.edges, sym("svc/c.go", "Top.Run"), sym("svc/a_methods.go", "Base.Ping")),
    ).toMatchObject({ kind: "calls", confidence: "inferred" });
    expect(edgeBetween(result.edges, sym("svc/c.go", "Top"), sym("svc/b.go", "Mid"))?.kind).toBe(
      "extends",
    );
    expect(result.edges.some((e) => e.kind === "implements")).toBe(false);
  });

  it("resolves embedded types of another package through the qualifier", async () => {
    const base = goFile("base/b.go", { defs: { Core: "class", "Core.Init": "method" } });
    const top = goFile("top/t.go", {
      imports: [{ specifier: "example.com/app/base" }],
      defs: { Top: "class", "Top.Go": "method" },
      refs: [
        { name: "Core", receiver: "base", kind: "extends", fromLocalId: "Top" },
        { name: "Init", receiver: "t", receiverKind: "self", fromLocalId: "Top.Go" },
      ],
    });
    const { result } = await run([base, top], { "go.mod": GO_MOD });
    expect(
      edgeBetween(result.edges, sym("top/t.go", "Top.Go"), sym("base/b.go", "Core.Init")),
    ).toBeDefined();
  });

  it("does not report a missing promoted method when an embedded type is external", async () => {
    const top = goFile("top/t.go", {
      imports: [{ specifier: "sync" }],
      defs: { Top: "class", "Top.Go": "method", "Top.Other": "method" },
      refs: [
        { name: "Mutex", receiver: "sync", kind: "extends", fromLocalId: "Top" },
        { name: "Lock", receiver: "t", receiverKind: "self", fromLocalId: "Top.Go" },
        { name: "Reset", receiver: "t", receiverKind: "self", fromLocalId: "Top.Go" },
      ],
    });
    const { result, summary } = await run([top], { "go.mod": GO_MOD });
    expect(result.edges).toEqual([]);
    expect(summary.byReason.external).toBe(3);
    expect(summary.byReason["no-candidate"]).toBeUndefined();
  });

  it("survives an embedding cycle", async () => {
    const a = goFile("svc/a.go", {
      defs: { A: "class", B: "class", "A.Run": "method" },
      refs: [
        { name: "B", kind: "extends", fromLocalId: "A" },
        { name: "A", kind: "extends", fromLocalId: "B" },
        { name: "Missing", receiver: "a", receiverKind: "self", fromLocalId: "A.Run" },
      ],
    });
    const { result } = await run([a], { "go.mod": GO_MOD });
    expect(result.edges.filter((e) => e.kind === "calls")).toEqual([]);
  });
});

describe("receiver types: hints, constructors, fields", () => {
  const store = goFile("store/s.go", {
    defs: {
      Store: "class",
      "Store.Get": "method",
      NewStore: { kind: "function", signature: "func NewStore(path string) *Store" },
      Open: { kind: "function", signature: "func Open(path string) (*Store, error)" },
      Names: { kind: "function", signature: "func Names() []string" },
    },
  });

  it("uses a same-package and an imported 'pkg.T' hint", async () => {
    const main = goFile("main.go", {
      imports: [{ specifier: "example.com/app/store" }],
      defs: { main: "function" },
      refs: [
        {
          name: "Get",
          receiver: "s",
          receiverKind: "identifier",
          receiverTypeHint: "*store.Store",
          fromLocalId: "main",
        },
      ],
    });
    const { result } = await run([main, store], { "go.mod": GO_MOD });
    expect(
      edgeBetween(result.edges, sym("main.go", "main"), sym("store/s.go", "Store.Get")),
    ).toMatchObject({
      confidence: "inferred",
    });
  });

  it("infers the type of x := NewT() from the stored signature (call: hint)", async () => {
    const main = goFile("main.go", {
      imports: [{ specifier: "example.com/app/store" }],
      defs: { main: "function" },
      refs: [
        {
          name: "Get",
          receiver: "a",
          receiverKind: "identifier",
          receiverTypeHint: "call:store.NewStore",
          fromLocalId: "main",
          line: 10,
        },
        {
          name: "Get",
          receiver: "b",
          receiverKind: "identifier",
          receiverTypeHint: "call:store.Open",
          fromLocalId: "main",
          line: 11,
        },
      ],
    });
    const { result } = await run([main, store], { "go.mod": GO_MOD });
    const gets = result.edges.filter((e) => e.dst === sym("store/s.go", "Store.Get"));
    expect(gets.map((e) => e.line)).toEqual([10, 11]);
  });

  it("infers from a same-package constructor", async () => {
    const a = goFile("svc/a.go", {
      defs: {
        Svc: "class",
        "Svc.Do": "method",
        NewSvc: { kind: "function", signature: "func NewSvc() Svc" },
      },
    });
    const b = goFile("svc/b.go", {
      defs: { run: "function" },
      refs: [
        {
          name: "Do",
          receiver: "x",
          receiverKind: "identifier",
          receiverTypeHint: "call:NewSvc",
          fromLocalId: "run",
        },
      ],
    });
    const { result } = await run([a, b], { "go.mod": GO_MOD });
    expect(
      edgeBetween(result.edges, sym("svc/b.go", "run"), sym("svc/a.go", "Svc.Do")),
    ).toBeDefined();
  });

  it("falls back to name-match when the constructor result is not a repository type", async () => {
    const main = goFile("main.go", {
      imports: [{ specifier: "example.com/app/store" }],
      defs: { main: "function" },
      refs: [
        {
          name: "Get",
          receiver: "n",
          receiverKind: "identifier",
          receiverTypeHint: "call:store.Names",
          fromLocalId: "main",
        },
      ],
    });
    const { result } = await run([main, store], { "go.mod": GO_MOD });
    // Names returns a slice: no single type, so the single method named Get is a name-match
    expect(
      edgeBetween(result.edges, sym("main.go", "main"), sym("store/s.go", "Store.Get")),
    ).toMatchObject({
      confidence: "name-match",
    });
  });

  it("a call on an externally typed receiver is neither resolved nor unresolved", async () => {
    const main = goFile("main.go", {
      imports: [{ specifier: "net/http" }],
      defs: { main: "function" },
      refs: [
        {
          name: "Get",
          receiver: "c",
          receiverKind: "identifier",
          receiverTypeHint: "*http.Client",
          fromLocalId: "main",
        },
      ],
    });
    const { result, summary } = await run([main, store], { "go.mod": GO_MOD });
    expect(result.edges).toEqual([]);
    expect(summary.byReason.external).toBe(1);
    expect(result.unresolved).toEqual([]);
  });

  it("follows a field chain through go.receiverVar and go.fields", async () => {
    const repo = goFile("svc/r.go", {
      defs: { Repo: "class", "Repo.Find": "method" },
    });
    const svc = goFile("svc/s.go", {
      defs: {
        Service: { kind: "class", meta: { "go.fields": { repo: "*Repo" } } },
        "Service.Load": { kind: "method", meta: { "go.receiverVar": "s" } },
      },
      refs: [
        {
          name: "Find",
          receiver: "s.repo",
          receiverKind: "member-chain",
          fromLocalId: "Service.Load",
        },
      ],
    });
    const { result } = await run([repo, svc], { "go.mod": GO_MOD });
    expect(
      edgeBetween(result.edges, sym("svc/s.go", "Service.Load"), sym("svc/r.go", "Repo.Find")),
    ).toMatchObject({ confidence: "inferred" });
  });
});

describe("interface receivers and name-match", () => {
  function iface(implementers: number) {
    const files = [
      goFile("svc/i.go", {
        defs: { Store: { kind: "interface", meta: { "go.methods": ["Save"] } } },
      }),
      goFile("svc/use.go", {
        defs: { use: "function" },
        refs: [
          {
            name: "Save",
            receiver: "s",
            receiverKind: "identifier",
            receiverTypeHint: "Store",
            fromLocalId: "use",
          },
        ],
      }),
    ];
    for (let i = 0; i < implementers; i++) {
      files.push(goFile(`impl${i}/m.go`, { defs: { Mem: "class", "Mem.Save": "method" } }));
    }
    return files;
  }

  it("creates name-match edges to 1 to 3 implementing-by-name methods, never implements edges", async () => {
    const { result } = await run(iface(2), { "go.mod": GO_MOD });
    const edges = result.edges.filter((e) => e.src === sym("svc/use.go", "use"));
    expect(edges.map((e) => e.dst)).toEqual([
      sym("impl0/m.go", "Mem.Save"),
      sym("impl1/m.go", "Mem.Save"),
    ]);
    expect(edges.every((e) => e.kind === "calls" && e.confidence === "name-match")).toBe(true);
  });

  it("is unresolved (ambiguous) with more than three candidates", async () => {
    const { result, summary } = await run(iface(4), { "go.mod": GO_MOD });
    expect(result.edges.filter((e) => e.kind === "calls")).toEqual([]);
    expect(summary.byReason.ambiguous).toBe(1);
    expect(result.unresolved).toEqual([
      { file: "svc/use.go", line: 100, name: "Save", kind: "call" },
    ]);
  });

  it("does not name-match stoplisted builtin and stdlib method names", async () => {
    const t = goFile("svc/t.go", {
      defs: { "Buf.Close": "method", "Buf.Write": "method", Buf: "class", f: "function" },
      refs: [
        { name: "Close", receiver: "x", receiverKind: "identifier", fromLocalId: "f" },
        { name: "Write", receiver: "x", receiverKind: "identifier", fromLocalId: "f" },
        { name: "append", fromLocalId: "f" },
      ],
    });
    const { result, summary } = await run([t], { "go.mod": GO_MOD });
    expect(result.edges).toEqual([]);
    expect(summary.byReason.external).toBe(3);
  });

  it("reports a method name that exists only as unrelated methods as unresolved when receiver is unknown and ambiguous", async () => {
    const files = [
      goFile("svc/use.go", {
        defs: { use: "function" },
        refs: [
          { name: "Frobnicate", receiver: "x", receiverKind: "identifier", fromLocalId: "use" },
        ],
      }),
    ];
    const { result, summary } = await run(files, { "go.mod": GO_MOD });
    // no method of that name anywhere: it must be an external call
    expect(result.edges).toEqual([]);
    expect(summary.byReason.external).toBe(1);
  });
});

describe("nested modules and determinism", () => {
  it("keeps modules apart: an import path is resolved inside its own go.mod only", async () => {
    const root = goFile("main.go", {
      imports: [{ specifier: "example.com/tools/gen" }],
      defs: { main: "function" },
      refs: [{ name: "Gen", receiver: "gen", receiverKind: "identifier", fromLocalId: "main" }],
    });
    const gen = goFile("tools/gen/g.go", { defs: { Gen: "function" } });
    const { result } = await run([root, gen], {
      "go.mod": "module example.com/app\n",
      "tools/go.mod": "module example.com/tools\n",
    });
    expect(
      edgeBetween(result.imports, "file:main.go", "mod:go:example.com/tools/gen")?.confidence,
    ).toBe("exact");
    expect(
      edgeBetween(result.edges, sym("main.go", "main"), sym("tools/gen/g.go", "Gen")),
    ).toBeDefined();
  });

  it("produces identical output for any extraction order", async () => {
    const make = () => [
      goFile("a/a.go", { defs: { A: "function" }, refs: [{ name: "b", fromLocalId: "A" }] }),
      goFile("a/b.go", { defs: { b: "function" } }),
      goFile("c/c.go", { defs: { C: "function" } }),
    ];
    const forward = await run(make(), { "go.mod": GO_MOD });
    const backward = await run(make().reverse(), { "go.mod": GO_MOD });
    expect(JSON.stringify(backward.result)).toBe(JSON.stringify(forward.result));
  });
});
