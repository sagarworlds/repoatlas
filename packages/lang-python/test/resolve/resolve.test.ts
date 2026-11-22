import type { FileExtraction, GraphEdge } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { pythonResolve } from "../../src/resolve/index.ts";
import { buildIndex, extraction, run, sym } from "./helpers.ts";

const edge = (edges: GraphEdge[], src: string, dst: string): GraphEdge | undefined =>
  edges.find((e) => e.src === src && e.dst === dst);

/** A small hand-built version of fixtures/python: models, a re-exporting package, a service. */
function shop(): FileExtraction[] {
  const models = extraction("src/shop/models.py", {
    defs: {
      Entity: "class",
      "Entity.__init__": "method",
      "Entity.touch": "method",
      User: "class",
      "User.__init__": "method",
      "User.save": "method",
      "User.create": "method",
      Order: "class",
      "Order.__init__": "method",
      "Order.total": "method",
    },
    refs: [
      { kind: "extends", name: "Entity", fromLocalId: "User" },
      { kind: "extends", name: "Entity", fromLocalId: "Order" },
      { name: "__init__", receiver: "super", receiverKind: "super", fromLocalId: "User.__init__" },
      { name: "touch", receiver: "self", receiverKind: "self", fromLocalId: "User.save" },
      { name: "User", fromLocalId: "User.create" },
    ],
  });
  const init = extraction("src/shop/__init__.py", {
    imports: [
      {
        specifier: ".models",
        kind: "named",
        names: [{ name: "User" }, { name: "Order" }],
        isRelative: true,
      },
    ],
  });
  const service = extraction("src/shop/service.py", {
    defs: { Admin: "class", "Admin.promote": "method", load: "function", register: "function" },
    imports: [
      { specifier: "shop", kind: "named", names: [{ name: "User" }] },
      { specifier: "shop.models", kind: "module", alias: "m" },
    ],
    refs: [
      { kind: "extends", name: "User", fromLocalId: "Admin" },
      { name: "save", receiver: "self", receiverKind: "self", fromLocalId: "Admin.promote" },
      { name: "User", fromLocalId: "register" },
      { name: "Order", receiver: "m", receiverKind: "identifier", fromLocalId: "load" },
      { name: "create", receiver: "m.User", receiverKind: "member-chain", fromLocalId: "load" },
      { name: "create", receiver: "User", receiverKind: "identifier", fromLocalId: "register" },
    ],
  });
  return [models, init, service];
}

describe("pythonResolve: edges and confidences", () => {
  it("resolves super(), self, constructors, aliases and class attribute chains", async () => {
    const { result } = await run(shop());
    const e = result.edges;
    const m = (n: string): string => sym("src/shop/models.py", n);
    const s = (n: string): string => sym("src/shop/service.py", n);

    expect(edge(e, m("User"), m("Entity"))).toMatchObject({
      kind: "extends",
      confidence: "inferred",
    });
    expect(edge(e, s("Admin"), m("User"))).toMatchObject({ kind: "extends" });
    // super().__init__() -> Entity.__init__
    expect(edge(e, m("User.__init__"), m("Entity.__init__"))).toMatchObject({ kind: "calls" });
    // self.touch() inherited from Entity
    expect(edge(e, m("User.save"), m("Entity.touch"))).toMatchObject({ kind: "calls" });
    // self.save() in Admin reaches User.save through the re-exported base class
    expect(edge(e, s("Admin.promote"), m("User.save"))).toMatchObject({ kind: "calls" });
    // User(...) -> User.__init__ (through the re-export in shop/__init__.py)
    expect(edge(e, s("register"), m("User.__init__"))).toMatchObject({ kind: "calls" });
    // m.Order(...) with m = shop.models -> Order.__init__ (defined on Order)
    expect(edge(e, s("load"), m("Order.__init__"))).toMatchObject({ kind: "calls" });
    // m.User.create(): module alias, then class, then member
    expect(edge(e, s("load"), m("User.create"))).toMatchObject({
      kind: "calls",
      confidence: "inferred",
    });
    // User.create() with User bound by import
    expect(edge(e, s("register"), m("User.create"))).toBeDefined();
    // a call to a class defined in the same file as its constructor
    expect(edge(e, m("User.create"), m("User.__init__"))).toMatchObject({ kind: "calls" });
  });

  it("emits a references edge when a called class has no constructor", async () => {
    const lib = extraction("lib.py", { defs: { Plain: "class" } });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "lib", kind: "named", names: [{ name: "Plain" }] }],
      refs: [{ name: "Plain", fromLocalId: "go" }],
    });
    const { result } = await run([lib, app]);
    expect(result.edges).toEqual([
      expect.objectContaining({
        src: sym("app.py", "go"),
        dst: sym("lib.py", "Plain"),
        kind: "references",
      }),
    ]);
  });

  it("uses the file node as source for module-level code", async () => {
    const app = extraction("app.py", {
      defs: { main: "function" },
      refs: [{ name: "main", line: 9 }],
    });
    const { result } = await run([app]);
    expect(result.edges).toEqual([
      {
        src: "file:app.py",
        dst: sym("app.py", "main"),
        kind: "calls",
        confidence: "inferred",
        line: 9,
      },
    ]);
  });

  it("resolves through receiverTypeHint", async () => {
    const lib = extraction("lib.py", { defs: { Repo: "class", "Repo.save": "method" } });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "lib", kind: "named", names: [{ name: "Repo" }] }],
      refs: [
        {
          name: "save",
          receiver: "r",
          receiverKind: "identifier",
          receiverTypeHint: "Repo",
          fromLocalId: "go",
        },
      ],
    });
    const { result } = await run([lib, app]);
    expect(edge(result.edges, sym("app.py", "go"), sym("lib.py", "Repo.save"))).toMatchObject({
      kind: "calls",
      confidence: "inferred",
    });
  });

  it("falls back to name-match with one edge per candidate (2-3 candidates)", async () => {
    const a = extraction("a.py", { defs: { A: "class", "A.render": "method" } });
    const b = extraction("b.py", { defs: { B: "class", "B.render": "method" } });
    const app = extraction("app.py", {
      defs: { export: "function" },
      refs: [
        { name: "render", receiver: "report", receiverKind: "identifier", fromLocalId: "export" },
      ],
    });
    const { result } = await run([a, b, app]);
    expect(result.edges.map((e) => [e.dst, e.confidence])).toEqual([
      [sym("a.py", "A.render"), "name-match"],
      [sym("b.py", "B.render"), "name-match"],
    ]);
  });
});

describe("pythonResolve: precedence", () => {
  it("a local definition beats an imported name", async () => {
    const lib = extraction("lib.py", { defs: { helper: "function" } });
    const app = extraction("app.py", {
      defs: { helper: "function", go: "function" },
      imports: [{ specifier: "lib", kind: "named", names: [{ name: "helper" }] }],
      refs: [{ name: "helper", fromLocalId: "go" }],
    });
    const { result } = await run([lib, app]);
    expect(result.edges.map((e) => e.dst)).toEqual([sym("app.py", "helper")]);
  });

  it("a nested function beats a module-level one", async () => {
    const app = extraction("app.py", {
      defs: { helper: "function", go: "function", "go.helper": "function" },
      refs: [{ name: "helper", fromLocalId: "go" }],
    });
    const { result } = await run([app]);
    expect(result.edges.map((e) => e.dst)).toEqual([sym("app.py", "go.helper")]);
  });

  it("a later import rebinds the name", async () => {
    const one = extraction("one.py", { defs: { f: "function" } });
    const two = extraction("two.py", { defs: { f: "function" } });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [
        { specifier: "one", kind: "named", names: [{ name: "f" }] },
        { specifier: "two", kind: "named", names: [{ name: "f" }] },
      ],
      refs: [{ name: "f", fromLocalId: "go" }],
    });
    const { result } = await run([one, two, app]);
    expect(result.edges.map((e) => e.dst)).toEqual([sym("two.py", "f")]);
  });

  it("there is no implicit same-package visibility: a sibling is not seen without an import", async () => {
    const sib = extraction("pkg/sib.py", { defs: { only_here: "function" } });
    const other = extraction("pkg/other.py", {
      defs: { go: "function" },
      refs: [{ name: "only_here", fromLocalId: "go" }],
    });
    const { result } = await run([sib, other]);
    // Not found by scope; the global name-match is the only thing that can link it.
    expect(result.edges.map((e) => e.confidence)).toEqual(["name-match"]);
  });
});

describe("pythonResolve: externals and unresolved", () => {
  const ext = () => {
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [
        { specifier: "requests", kind: "module" },
        { specifier: "os", kind: "module" },
      ],
      refs: [
        { name: "get", receiver: "requests", receiverKind: "identifier", fromLocalId: "go" },
        { name: "join", receiver: "os.path", receiverKind: "member-chain", fromLocalId: "go" },
      ],
    });
    const helper = extraction("helper.py", { defs: { join: "function", get: "function" } });
    return [app, helper];
  };

  it("calls through an external module produce no edge and no unresolved entry", async () => {
    const { result } = await run(ext());
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(edge(result.imports, "file:app.py", "ext:pypi:requests")).toBeDefined();
    expect(edge(result.imports, "file:app.py", "ext:pypi:stdlib")).toBeDefined();
  });

  it("reports genuinely unknown calls as unresolved, but not builtins", async () => {
    const app = extraction("app.py", {
      defs: { go: "function" },
      refs: [
        { name: "mystery", fromLocalId: "go", line: 5 },
        { name: "len", fromLocalId: "go", line: 6 },
        { name: "strip", receiver: "text", receiverKind: "identifier", fromLocalId: "go", line: 7 },
        { kind: "extends", name: "Exception", fromLocalId: "go", line: 8 },
      ],
    });
    const { result, summary } = await run([app]);
    expect(result.unresolved).toEqual([{ file: "app.py", line: 5, name: "mystery", kind: "call" }]);
    expect(summary.total).toBe(4);
    expect(summary.unresolved).toBe(4);
    expect(summary.byReason["no-candidate"]).toBe(4);
  });

  it("does not name-match stoplisted Python names", async () => {
    const reg = extraction("reg.py", {
      defs: { Reg: "class", "Reg.items": "method", "Reg.get": "method" },
    });
    const app = extraction("app.py", {
      defs: { go: "function" },
      refs: [
        { name: "items", receiver: "d", receiverKind: "identifier", fromLocalId: "go" },
        { name: "get", receiver: "d", receiverKind: "identifier", fromLocalId: "go" },
      ],
    });
    const { result } = await run([reg, app]);
    expect(result.edges).toEqual([]);
  });
});

describe("pythonResolve: robustness", () => {
  it("is deterministic and independent of input order", async () => {
    const files = shop();
    const first = await run(files);
    const second = await run([...files].reverse());
    expect(second.result).toEqual(first.result);
    expect(JSON.stringify(await first.resolve())).toBe(JSON.stringify(first.result));
  });

  it("does not mutate its inputs", async () => {
    const files = shop();
    const before = JSON.stringify(files);
    await run(files);
    expect(JSON.stringify(files)).toBe(before);
  });

  it("works without prepare info by inferring roots from the file paths", async () => {
    const files = shop();
    const result = await pythonResolve({
      extractions: files,
      index: buildIndex(files),
      info: {},
      repo: {
        exists: () => false,
        isDir: () => false,
        read: async () => undefined,
        readSync: () => undefined,
        list: () => [],
      },
    });
    expect(result.imports.some((e) => e.dst === "file:src/shop/models.py")).toBe(true);
  });

  it("validates its output shape (ids, kinds, lines)", async () => {
    const { result } = await run(shop());
    for (const e of [...result.imports, ...result.edges]) {
      expect(e.src).toMatch(/^(file|sym):/);
      expect(e.dst).toMatch(/^(file|sym|ext):/);
      if (e.line !== undefined) expect(e.line).toBeGreaterThanOrEqual(1);
    }
    for (const n of result.externals) expect(n.id.startsWith("ext:pypi:")).toBe(true);
  });

  it("survives a reference whose enclosing definition is unknown", async () => {
    const app = extraction("app.py", {
      defs: { f: "function" },
      refs: [{ name: "f", fromLocalId: "ghost" }],
    });
    const { result } = await run([app]);
    expect(result.edges).toHaveLength(1);
  });
});
