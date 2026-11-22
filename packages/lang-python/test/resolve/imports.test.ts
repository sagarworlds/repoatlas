import type { GraphEdge } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { parseDunderAll } from "../../src/resolve/dunder-all.ts";
import { extraction, run, sym } from "./helpers.ts";

const edge = (edges: GraphEdge[], src: string, dst: string): GraphEdge | undefined =>
  edges.find((e) => e.src === src && e.dst === dst);

const f = (path: string): string => `file:${path}`;

describe("absolute imports", () => {
  it("import a.b binds a and the dotted chain, and links the module file", async () => {
    const lib = extraction("src/shop/models.py", { defs: { User: "class" } });
    const pkg = extraction("src/shop/__init__.py");
    const app = extraction("app.py", {
      imports: [{ specifier: "shop.models", kind: "module" }],
      refs: [
        { name: "User", receiver: "shop.models", receiverKind: "member-chain", fromLocalId: "go" },
      ],
      defs: { go: "function" },
    });
    const { result } = await run([lib, pkg, app]);
    const e = edge(result.imports, f("app.py"), f("src/shop/models.py"));
    expect(e?.confidence).toBe("exact");
    expect(e?.kind).toBe("imports");
    // shop.models.User(): receiver chain through the dotted binding, User has no __init__
    const ref = result.edges.find((x) => x.src === sym("app.py", "go"));
    expect(ref).toMatchObject({ dst: sym("src/shop/models.py", "User"), kind: "references" });
  });

  it("import a.b as c binds c to the module", async () => {
    const lib = extraction("shop/models.py", { defs: { make: "function" } });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "shop.models", kind: "module", alias: "m" }],
      refs: [{ name: "make", receiver: "m", receiverKind: "identifier", fromLocalId: "go" }],
    });
    const { result } = await run([lib, app]);
    expect(edge(result.imports, f("app.py"), f("shop/models.py"))?.meta?.alias).toBe("m");
    expect(edge(result.edges, sym("app.py", "go"), sym("shop/models.py", "make"))).toMatchObject({
      kind: "calls",
      confidence: "inferred",
    });
  });

  it("from a.b import x binds a symbol; with alias binds the alias", async () => {
    const lib = extraction("shop/models.py", { defs: { User: "class", helper: "function" } });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [
        {
          specifier: "shop.models",
          kind: "named",
          names: [{ name: "User" }, { name: "helper", alias: "h" }],
        },
      ],
      refs: [{ name: "h", fromLocalId: "go" }],
    });
    const { result } = await run([lib, app]);
    expect(edge(result.edges, sym("app.py", "go"), sym("shop/models.py", "helper"))).toBeDefined();
    const imp = edge(result.imports, f("app.py"), f("shop/models.py"));
    expect(imp?.meta?.importedNames).toEqual(["User", "helper"]);
    expect(imp?.confidence).toBe("exact");
  });

  it("from pkg import name where name is a submodule links the submodule", async () => {
    const init = extraction("pkg/__init__.py");
    const sub = extraction("pkg/sub.py", { defs: { f: "function" } });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "pkg", kind: "named", names: [{ name: "sub" }] }],
      refs: [{ name: "f", receiver: "sub", receiverKind: "identifier", fromLocalId: "go" }],
    });
    const { result } = await run([init, sub, app]);
    expect(edge(result.imports, f("app.py"), f("pkg/__init__.py"))).toBeDefined();
    expect(edge(result.imports, f("app.py"), f("pkg/sub.py"))?.confidence).toBe("exact");
    expect(edge(result.edges, sym("app.py", "go"), sym("pkg/sub.py", "f"))).toBeDefined();
  });

  it("a from-imported name that is defined beats a submodule of the same name", async () => {
    const init = extraction("pkg/__init__.py", { defs: { thing: "function" } });
    const sub = extraction("pkg/thing.py", { defs: { other: "function" } });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "pkg", kind: "named", names: [{ name: "thing" }] }],
      refs: [{ name: "thing", fromLocalId: "go" }],
    });
    const { result } = await run([init, sub, app]);
    expect(edge(result.edges, sym("app.py", "go"), sym("pkg/__init__.py", "thing"))).toBeDefined();
  });

  it("skips __future__ imports entirely", async () => {
    const app = extraction("app.py", {
      imports: [{ specifier: "__future__", kind: "named", names: [{ name: "annotations" }] }],
    });
    const { result } = await run([app]);
    expect(result.imports).toEqual([]);
    expect(result.externals).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("merges several imports of one module into one edge", async () => {
    const lib = extraction("lib.py", { defs: { a: "function", b: "function" } });
    const app = extraction("app.py", {
      imports: [
        { line: 3, specifier: "lib", kind: "named", names: [{ name: "b" }] },
        { line: 1, specifier: "lib", kind: "named", names: [{ name: "a" }] },
      ],
    });
    const { result } = await run([lib, app]);
    const edges = result.imports.filter((e) => e.src === f("app.py"));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ line: 1, meta: { importedNames: ["a", "b"] } });
  });

  it("imports inside functions and try/except still produce edges and bindings", async () => {
    // The extractor reports them like any import; the binding is file-wide.
    const lib = extraction("lib.py", { defs: { slug: "function" } });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ line: 7, specifier: "lib", kind: "named", names: [{ name: "slug" }] }],
      refs: [{ name: "slug", fromLocalId: "go" }],
    });
    const { result } = await run([lib, app]);
    expect(edge(result.imports, f("app.py"), f("lib.py"))?.line).toBe(7);
    expect(edge(result.edges, sym("app.py", "go"), sym("lib.py", "slug"))).toBeDefined();
  });

  it("handles circular imports without looping", async () => {
    const a = extraction("a.py", {
      defs: { fa: "function" },
      imports: [{ specifier: "b", kind: "named", names: [{ name: "fb" }] }],
    });
    const b = extraction("b.py", {
      defs: { fb: "function", caller: "function" },
      imports: [{ specifier: "a", kind: "named", names: [{ name: "fa" }] }],
      refs: [{ name: "fa", fromLocalId: "caller" }],
    });
    const { result } = await run([a, b]);
    expect(edge(result.imports, f("a.py"), f("b.py"))).toBeDefined();
    expect(edge(result.imports, f("b.py"), f("a.py"))).toBeDefined();
    expect(edge(result.edges, sym("b.py", "caller"), sym("a.py", "fa"))).toBeDefined();
  });

  it("circular re-exports between packages terminate", async () => {
    const p = extraction("p/__init__.py", {
      imports: [{ specifier: "q", kind: "named", names: [{ name: "X" }] }],
    });
    const q = extraction("q/__init__.py", {
      imports: [{ specifier: "p", kind: "named", names: [{ name: "X" }] }],
    });
    const app = extraction("app.py", {
      imports: [{ specifier: "p", kind: "named", names: [{ name: "X" }] }],
    });
    await expect(run([p, q, app])).resolves.toBeDefined();
  });
});

describe("relative imports", () => {
  const files = () => [
    extraction("src/shop/__init__.py"),
    extraction("src/shop/a.py", { defs: { fa: "function" } }),
    extraction("src/shop/sub/__init__.py", { defs: { initfn: "function" } }),
    extraction("src/shop/sub/b.py", { defs: { fb: "function" } }),
  ];

  it("resolves one dot from a module and from an __init__.py", async () => {
    const c = extraction("src/shop/sub/c.py", {
      defs: { go: "function" },
      imports: [{ specifier: ".b", kind: "named", names: [{ name: "fb" }], isRelative: true }],
      refs: [{ name: "fb", fromLocalId: "go" }],
    });
    const init = extraction("src/shop/sub/__init__.py", {
      defs: { initfn: "function" },
      imports: [{ specifier: ".b", kind: "named", names: [{ name: "fb" }], isRelative: true }],
    });
    const base = files().filter((x) => x.file !== "src/shop/sub/__init__.py");
    const { result } = await run([...base, init, c]);
    expect(edge(result.imports, f("src/shop/sub/c.py"), f("src/shop/sub/b.py"))).toBeDefined();
    expect(
      edge(result.imports, f("src/shop/sub/__init__.py"), f("src/shop/sub/b.py")),
    ).toBeDefined();
    expect(
      edge(result.edges, sym("src/shop/sub/c.py", "go"), sym("src/shop/sub/b.py", "fb")),
    ).toBeDefined();
  });

  it("two dots go up one package; `from . import x` and `from .. import x` bind submodules", async () => {
    const c = extraction("src/shop/sub/c.py", {
      defs: { go: "function" },
      imports: [
        { specifier: "..a", kind: "named", names: [{ name: "fa" }], isRelative: true },
        { specifier: ".", kind: "named", names: [{ name: "b" }], isRelative: true },
        { specifier: "..", kind: "named", names: [{ name: "a" }], isRelative: true },
      ],
      refs: [
        { name: "fa", fromLocalId: "go" },
        { name: "fb", receiver: "b", receiverKind: "identifier", fromLocalId: "go" },
      ],
    });
    const { result } = await run([...files(), c]);
    expect(edge(result.imports, f("src/shop/sub/c.py"), f("src/shop/a.py"))).toBeDefined();
    expect(edge(result.imports, f("src/shop/sub/c.py"), f("src/shop/sub/b.py"))).toBeDefined();
    expect(
      edge(result.edges, sym("src/shop/sub/c.py", "go"), sym("src/shop/a.py", "fa")),
    ).toBeDefined();
    expect(
      edge(result.edges, sym("src/shop/sub/c.py", "go"), sym("src/shop/sub/b.py", "fb")),
    ).toBeDefined();
  });

  it("going beyond the top package is unresolved and creates no edge", async () => {
    const c = extraction("src/shop/a2.py", {
      imports: [
        { line: 4, specifier: "...x", kind: "named", names: [{ name: "y" }], isRelative: true },
      ],
    });
    const { result } = await run([...files(), c]);
    expect(result.unresolved).toContainEqual({
      file: "src/shop/a2.py",
      line: 4,
      name: "...x",
      kind: "import",
    });
    expect(result.imports.filter((e) => e.src === f("src/shop/a2.py"))).toEqual([]);
  });

  it("three dots reach the root package level but not beyond", async () => {
    const top = extraction("src/shop/sub/deep/m.py", {
      imports: [{ specifier: "...a", kind: "named", names: [{ name: "fa" }], isRelative: true }],
    });
    const { result } = await run([...files(), top]);
    // module shop.sub.deep.m: package shop.sub.deep, 3 dots -> shop
    expect(edge(result.imports, f("src/shop/sub/deep/m.py"), f("src/shop/a.py"))).toBeDefined();
  });

  it("a relative import that names a missing module is unresolved", async () => {
    const c = extraction("src/shop/a3.py", {
      imports: [{ specifier: ".missing", kind: "named", names: [{ name: "q" }], isRelative: true }],
    });
    const { result } = await run([...files(), c]);
    expect(result.unresolved.map((u) => u.name)).toContain(".missing");
  });
});

describe("re-exports", () => {
  const models = extraction("src/shop/models.py", {
    defs: { User: "class", "User.save": "method" },
  });
  const init = extraction("src/shop/__init__.py", {
    imports: [{ specifier: ".models", kind: "named", names: [{ name: "User" }], isRelative: true }],
  });

  it("from pkg import name follows ONE level of re-export through __init__.py", async () => {
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "shop", kind: "named", names: [{ name: "User" }] }],
      refs: [
        { name: "User", fromLocalId: "go" },
        { name: "save", receiver: "User", fromLocalId: "go" },
      ],
    });
    const { result } = await run([models, init, app]);
    const imp = edge(result.imports, f("app.py"), f("src/shop/__init__.py"));
    expect(imp?.confidence).toBe("inferred");
    expect(imp?.meta?.isReexport).toBe(true);
    expect(
      edge(result.edges, sym("app.py", "go"), sym("src/shop/models.py", "User")),
    ).toMatchObject({
      kind: "references",
    });
    expect(
      edge(result.edges, sym("app.py", "go"), sym("src/shop/models.py", "User.save")),
    ).toBeDefined();
  });

  it("does not follow a second level", async () => {
    const deep = extraction("src/shop/deep.py", { defs: { Thing: "class" } });
    const mid = extraction("src/shop/mid/__init__.py", {
      imports: [{ specifier: "shop.deep", kind: "named", names: [{ name: "Thing" }] }],
    });
    const top = extraction("src/shop/__init__.py", {
      imports: [{ specifier: "shop.mid", kind: "named", names: [{ name: "Thing" }] }],
    });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "shop", kind: "named", names: [{ name: "Thing" }] }],
      refs: [{ name: "Thing", fromLocalId: "go" }],
    });
    const { result } = await run([deep, mid, top, app]);
    // `top` re-exports mid's binding, which is itself a re-export: app gets nothing for Thing.
    expect(result.edges.filter((e) => e.src === sym("app.py", "go"))).toEqual([]);
  });

  it("a class extending a re-exported class resolves its bases", async () => {
    const svc = extraction("svc.py", {
      defs: { Admin: "class", "Admin.promote": "method" },
      imports: [{ specifier: "shop", kind: "named", names: [{ name: "User" }] }],
      refs: [
        { kind: "extends", name: "User", fromLocalId: "Admin" },
        { name: "save", receiver: "self", receiverKind: "self", fromLocalId: "Admin.promote" },
      ],
    });
    const { result } = await run([models, init, svc]);
    expect(
      edge(result.edges, sym("svc.py", "Admin"), sym("src/shop/models.py", "User")),
    ).toMatchObject({
      kind: "extends",
    });
    expect(
      edge(result.edges, sym("svc.py", "Admin.promote"), sym("src/shop/models.py", "User.save")),
    ).toBeDefined();
  });
});

describe("wildcard imports", () => {
  const lib = extraction("lib.py", {
    defs: { pub: "function", _private: "function", other: "function" },
  });

  it("binds every public top-level name when there is no __all__", async () => {
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "lib", kind: "wildcard" }],
      refs: [
        { name: "pub", fromLocalId: "go" },
        { name: "other", fromLocalId: "go" },
        { name: "_private", fromLocalId: "go" },
      ],
    });
    const { result } = await run([lib, app]);
    const calls = result.edges.filter((e) => e.src === sym("app.py", "go"));
    const byDst = new Map(calls.map((e) => [e.dst, e.confidence]));
    expect(byDst.get(sym("lib.py", "pub"))).toBe("inferred");
    expect(byDst.get(sym("lib.py", "other"))).toBe("inferred");
    expect(edge(result.imports, f("app.py"), f("lib.py"))).toMatchObject({
      confidence: "inferred",
      meta: { importedNames: ["*"] },
    });
  });

  it("respects a literal __all__ read from the source", async () => {
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "lib", kind: "wildcard" }],
      refs: [
        { name: "pub", fromLocalId: "go" },
        { name: "other", fromLocalId: "go" },
      ],
    });
    const { result } = await run([lib, app], {}, { "lib.py": '__all__ = ["pub"]\n' });
    // `other` is not exported, so the call is not resolved through the binding. It falls to
    // name-match, which is the weaker "name-match" confidence.
    const byDst = new Map(
      result.edges.filter((e) => e.src === sym("app.py", "go")).map((e) => [e.dst, e.confidence]),
    );
    expect(byDst.get(sym("lib.py", "pub"))).toBe("inferred");
    expect(byDst.get(sym("lib.py", "other"))).toBe("name-match");
  });

  it("takes __all__ from extraction meta py.all when the extractor provides it", async () => {
    const withMeta = extraction("lib.py", {
      defs: { pub: "function", other: "function" },
      meta: { "py.all": ["pub"] },
    });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "lib", kind: "wildcard" }],
      refs: [{ name: "other", fromLocalId: "go" }],
    });
    const { result } = await run([withMeta, app]);
    const edges = result.edges.filter((e) => e.src === sym("app.py", "go"));
    expect(edges.map((e) => e.confidence)).toEqual(["name-match"]);
  });

  it("includes names the target itself imports (one level) and external names", async () => {
    const hub = extraction("hub.py", {
      imports: [
        { specifier: "lib", kind: "named", names: [{ name: "pub" }] },
        { specifier: "requests", kind: "module" },
      ],
    });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "hub", kind: "wildcard" }],
      refs: [
        { name: "pub", fromLocalId: "go" },
        { name: "get", receiver: "requests", receiverKind: "identifier", fromLocalId: "go" },
      ],
    });
    const { result } = await run([lib, hub, app]);
    expect(edge(result.edges, sym("app.py", "go"), sym("lib.py", "pub"))).toBeDefined();
    expect(result.unresolved).toEqual([]); // requests.get is external, not unresolved
  });

  it("explicit imports shadow wildcard ones regardless of order", async () => {
    const other = extraction("other.py", { defs: { pub: "function" } });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [
        { specifier: "other", kind: "named", names: [{ name: "pub" }] },
        { specifier: "lib", kind: "wildcard" },
      ],
      refs: [{ name: "pub", fromLocalId: "go" }],
    });
    const { result } = await run([lib, other, app]);
    const dsts = result.edges.filter((e) => e.src === sym("app.py", "go")).map((e) => e.dst);
    expect(dsts).toEqual([sym("other.py", "pub")]);
  });

  it("parseDunderAll understands literals, += and refuses computed lists", () => {
    expect(parseDunderAll("__all__ = [\"a\", 'b']")).toEqual(["a", "b"]);
    expect(parseDunderAll('__all__ = (\n  "a",  # c\n  "b",\n)\n__all__ += ["c"]')).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(parseDunderAll("__all__ = other.__all__")).toBeUndefined();
    expect(parseDunderAll('__all__ = ["a"] + extra')).toBeUndefined();
    expect(parseDunderAll("x = 1")).toBeUndefined();
    expect(parseDunderAll('# __all__ = ["a"]')).toBeUndefined();
  });
});

describe("externals", () => {
  it("separates stdlib, third-party and internal imports", async () => {
    const lib = extraction("shop/a.py", { defs: { f: "function" } });
    const app = extraction("app.py", {
      imports: [
        { line: 1, specifier: "os.path", kind: "module" },
        { line: 2, specifier: "json", kind: "named", names: [{ name: "dumps" }] },
        { line: 3, specifier: "requests", kind: "module" },
        { line: 4, specifier: "numpy.linalg", kind: "named", names: [{ name: "norm" }] },
        { line: 5, specifier: "shop.a", kind: "named", names: [{ name: "f" }] },
      ],
    });
    const { result } = await run([lib, app]);
    const dsts = result.imports.filter((e) => e.src === f("app.py")).map((e) => e.dst);
    expect(dsts).toEqual([
      "ext:pypi:numpy",
      "ext:pypi:requests",
      "ext:pypi:stdlib",
      f("shop/a.py"),
    ]);
    expect(result.externals.map((n) => n.id)).toEqual([
      "ext:pypi:numpy",
      "ext:pypi:requests",
      "ext:pypi:stdlib",
    ]);
    expect(result.externals[0]).toMatchObject({
      kind: "external",
      name: "numpy",
      meta: { ecosystem: "pypi" },
    });
    const std = edge(result.imports, f("app.py"), "ext:pypi:stdlib");
    expect(std?.meta?.packages).toEqual(["json", "os.path"]);
    expect(std?.meta?.package).toBe("json");
  });

  it("one edge per (file, external) even when imported several times", async () => {
    const app = extraction("app.py", {
      imports: [
        { line: 1, specifier: "requests", kind: "module" },
        {
          line: 2,
          specifier: "requests.adapters",
          kind: "named",
          names: [{ name: "HTTPAdapter" }],
        },
      ],
    });
    const { result } = await run([app]);
    expect(result.imports.filter((e) => e.dst === "ext:pypi:requests")).toHaveLength(1);
  });

  it("an internal top-level name wins over a stdlib or third-party name", async () => {
    const mine = extraction("logging/handlers.py", { defs: { H: "class" } });
    const app = extraction("app.py", {
      imports: [{ specifier: "logging.handlers", kind: "named", names: [{ name: "H" }] }],
    });
    const { result } = await run([mine, app]);
    expect(edge(result.imports, f("app.py"), f("logging/handlers.py"))).toBeDefined();
    expect(result.externals).toEqual([]);
  });

  it("an internal package with a missing module is unresolved, not external", async () => {
    const pkg = extraction("shop/a.py");
    const app = extraction("app.py", {
      imports: [{ line: 2, specifier: "shop.nothing", kind: "module" }],
    });
    const { result } = await run([pkg, app]);
    expect(result.unresolved).toContainEqual({
      file: "app.py",
      line: 2,
      name: "shop.nothing",
      kind: "import",
    });
    expect(result.externals).toEqual([]);
  });

  it("dynamic imports link the module as inferred with isDynamic", async () => {
    const plug = extraction("plugins/x.py");
    const app = extraction("app.py", {
      imports: [{ specifier: "plugins.x", kind: "dynamic" }],
    });
    const { result } = await run([plug, app]);
    expect(edge(result.imports, f("app.py"), f("plugins/x.py"))).toMatchObject({
      confidence: "inferred",
      meta: { isDynamic: true },
    });
  });
});

describe("namespace packages and multiple roots", () => {
  it("resolves imports through an implicit namespace package", async () => {
    const mod = extraction("ns/sub/mod.py", { defs: { f: "function" } });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "ns.sub.mod", kind: "named", names: [{ name: "f" }] }],
      refs: [{ name: "f", fromLocalId: "go" }],
    });
    const { result } = await run([mod, app]);
    expect(edge(result.imports, f("app.py"), f("ns/sub/mod.py"))).toBeDefined();
    expect(edge(result.edges, sym("app.py", "go"), sym("ns/sub/mod.py", "f"))).toBeDefined();
  });

  it("from namespace import submodule works when the namespace has no file", async () => {
    const mod = extraction("ns/mod.py", { defs: { f: "function" } });
    const app = extraction("app.py", {
      defs: { go: "function" },
      imports: [{ specifier: "ns", kind: "named", names: [{ name: "mod" }] }],
      refs: [{ name: "f", receiver: "mod", receiverKind: "identifier", fromLocalId: "go" }],
    });
    const { result } = await run([mod, app]);
    expect(edge(result.imports, f("app.py"), f("ns/mod.py"))).toBeDefined();
    expect(edge(result.edges, sym("app.py", "go"), sym("ns/mod.py", "f"))).toBeDefined();
  });

  it("src layout plus repo-root scripts resolve to the same modules", async () => {
    const lib = extraction("src/shop/a.py", { defs: { f: "function" } });
    const init = extraction("src/shop/__init__.py");
    const script = extraction("scripts/run.py", {
      imports: [{ specifier: "shop.a", kind: "named", names: [{ name: "f" }] }],
    });
    const { result } = await run([lib, init, script]);
    expect(edge(result.imports, f("scripts/run.py"), f("src/shop/a.py"))).toBeDefined();
  });

  it("multiple roots from manifests", async () => {
    const core = extraction("libs/core/core/x.py", { defs: { cx: "function" } });
    const web = extraction("apps/web/web/y.py", {
      imports: [{ specifier: "core.x", kind: "named", names: [{ name: "cx" }] }],
    });
    const { result } = await run([core, web], {
      "pyproject.toml": '[tool.setuptools.packages.find]\nwhere = ["libs/core", "apps/web"]\n',
    });
    expect(edge(result.imports, f("apps/web/web/y.py"), f("libs/core/core/x.py"))).toBeDefined();
  });
});
