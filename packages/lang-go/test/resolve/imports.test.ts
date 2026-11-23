import { describe, expect, it } from "vitest";
import { tableFromDirs } from "../../src/prepare/index.ts";
import { classifyImport, packageNameGuesses } from "../../src/resolve/index.ts";
import { edgeBetween, file, goFile, run, sym } from "./helpers.ts";

const GO_MOD =
  "module github.com/acme/api\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n\tgolang.org/x/net v0.20.0\n)\n";

function repo() {
  const main = goFile("cmd/api/main.go", {
    pkg: "main",
    defs: { main: "function" },
    imports: [
      { specifier: "fmt" },
      { specifier: "net/http" },
      { specifier: "github.com/acme/api/internal/server" },
      { specifier: "github.com/acme/api/internal/store", alias: "st" },
      { specifier: "github.com/acme/api/internal/db" },
      { specifier: "github.com/acme/api/internal/plugins", kind: "side-effect", alias: "_" },
      { specifier: "github.com/acme/api/internal/util", kind: "wildcard", alias: "." },
      { specifier: "github.com/gin-gonic/gin" },
      { specifier: "github.com/gin-gonic/gin/binding" },
      { specifier: "golang.org/x/net/http2" },
      { specifier: "github.com/acme/api/gen/missing" },
    ],
    refs: [
      { name: "NewServer", receiver: "server", receiverKind: "identifier", fromLocalId: "main" },
      { name: "Open", receiver: "st", receiverKind: "identifier", fromLocalId: "main" },
      { name: "Connect", receiver: "database", receiverKind: "identifier", fromLocalId: "main" },
      { name: "Helper", fromLocalId: "main" },
      { name: "Default", receiver: "gin", receiverKind: "identifier", fromLocalId: "main" },
      { name: "Println", receiver: "fmt", receiverKind: "identifier", fromLocalId: "main" },
    ],
  });
  const server = goFile("internal/server/server.go", {
    defs: { Server: "class", NewServer: "function" },
  });
  // Directory "store" declares package "db"; directory "db" declares package "database".
  const store = goFile("internal/store/db.go", { pkg: "db", defs: { Open: "function" } });
  const db = goFile("internal/db/db.go", { pkg: "database", defs: { Connect: "function" } });
  const plugins = goFile("internal/plugins/p.go", { defs: { Register: "function" } });
  const util = goFile("internal/util/u.go", { defs: { Helper: "function" } });
  return [main, server, store, db, plugins, util];
}

describe("imports: edges and external nodes", () => {
  it("creates exact file -> module edges for internal packages", async () => {
    const { result } = await run(repo(), { "go.mod": GO_MOD });
    const src = file("cmd/api/main.go");
    const server = edgeBetween(result.imports, src, "mod:go:github.com/acme/api/internal/server");
    expect(server).toMatchObject({ kind: "imports", confidence: "exact", line: 3 });
    expect(server?.meta?.alias).toBeUndefined();
    const store = edgeBetween(result.imports, src, "mod:go:github.com/acme/api/internal/store");
    expect(store?.meta?.alias).toBe("st");
    // blank and dot imports produce the edge only
    expect(
      edgeBetween(result.imports, src, "mod:go:github.com/acme/api/internal/plugins"),
    ).toBeDefined();
    expect(
      edgeBetween(result.imports, src, "mod:go:github.com/acme/api/internal/util")?.meta?.alias,
    ).toBeUndefined();
  });

  it("collapses stdlib into one node and edge, with the packages in meta", async () => {
    const { result } = await run(repo(), { "go.mod": GO_MOD });
    const stdlib = result.imports.filter((e) => e.dst === "ext:go:stdlib");
    expect(stdlib).toHaveLength(1);
    expect(stdlib[0]?.meta).toMatchObject({ package: "fmt", packages: ["fmt", "net/http"] });
    expect(result.externals.map((n) => n.id)).toContain("ext:go:stdlib");
    expect(result.externals.every((n) => n.kind === "external" && n.meta?.ecosystem === "go")).toBe(
      true,
    );
  });

  it("names third-party modules from go.mod requires and merges subpackages into one edge", async () => {
    const { result } = await run(repo(), { "go.mod": GO_MOD });
    const gin = result.imports.filter((e) => e.dst === "ext:go:github.com/gin-gonic/gin");
    expect(gin).toHaveLength(1);
    expect(gin[0]?.meta?.packages).toEqual([
      "github.com/gin-gonic/gin",
      "github.com/gin-gonic/gin/binding",
    ]);
    expect(gin[0]?.confidence).toBe("exact");
    expect(result.imports.some((e) => e.dst === "ext:go:golang.org/x/net")).toBe(true);
  });

  it("reports an import below the module path with no package as unresolved, without an edge", async () => {
    const { result } = await run(repo(), { "go.mod": GO_MOD });
    expect(result.unresolved).toContainEqual({
      file: "cmd/api/main.go",
      line: 11,
      name: "github.com/acme/api/gen/missing",
      kind: "import",
    });
    expect(result.imports.some((e) => e.dst.includes("gen/missing"))).toBe(false);
    expect(result.externals.some((n) => n.id.includes("gen/missing"))).toBe(false);
  });

  it("emits one module node per package directory", async () => {
    const { result } = await run(repo(), { "go.mod": GO_MOD });
    const nodes = result.modules ?? [];
    expect(nodes.map((n) => n.id)).toEqual([
      "mod:go:github.com/acme/api/cmd/api",
      "mod:go:github.com/acme/api/internal/db",
      "mod:go:github.com/acme/api/internal/plugins",
      "mod:go:github.com/acme/api/internal/server",
      "mod:go:github.com/acme/api/internal/store",
      "mod:go:github.com/acme/api/internal/util",
    ]);
    const store = nodes.find((n) => n.name === "store");
    expect(store).toMatchObject({
      kind: "module",
      qualifiedName: "github.com/acme/api/internal/store",
      language: "go",
      meta: { language: "go", "go.package": "db", "go.dir": "internal/store" },
    });
  });
});

describe("imports: bindings", () => {
  it("binds the declared package name (not the directory name) or the alias", async () => {
    const { result } = await run(repo(), { "go.mod": GO_MOD });
    const from = sym("cmd/api/main.go", "main");
    // directory internal/db declares `package database`
    expect(edgeBetween(result.edges, from, sym("internal/db/db.go", "Connect"))).toMatchObject({
      kind: "calls",
      confidence: "inferred",
    });
    // alias st for internal/store (package db)
    expect(edgeBetween(result.edges, from, sym("internal/store/db.go", "Open"))).toBeDefined();
    expect(
      edgeBetween(result.edges, from, sym("internal/server/server.go", "NewServer")),
    ).toBeDefined();
  });

  it("dot import binds the exported names of the target package", async () => {
    const { result } = await run(repo(), { "go.mod": GO_MOD });
    expect(
      edgeBetween(
        result.edges,
        sym("cmd/api/main.go", "main"),
        sym("internal/util/u.go", "Helper"),
      ),
    ).toBeDefined();
  });

  it("makes no edge and no unresolved entry for calls through external packages", async () => {
    const { result, summary } = await run(repo(), { "go.mod": GO_MOD });
    expect(result.unresolved.filter((u) => u.kind === "call")).toEqual([]);
    expect(summary.byReason.external).toBe(2);
    expect(result.edges.some((e) => e.dst.startsWith("ext:"))).toBe(false);
  });

  it("does not bind a blank import", async () => {
    const main = goFile("main.go", {
      imports: [{ specifier: "m/plugins", kind: "side-effect", alias: "_" }],
      defs: { run: "function" },
      refs: [
        { name: "Register", receiver: "plugins", receiverKind: "identifier", fromLocalId: "run" },
      ],
    });
    const plugins = goFile("plugins/p.go", { defs: { Register: "function" } });
    const { result } = await run([main, plugins], { "go.mod": "module m\n" });
    expect(result.imports).toHaveLength(1);
    // `plugins` is not bound, so no import-member edge; name-match never links functions to receivers
    expect(result.edges).toEqual([]);
  });
});

describe("imports: module-less repositories and test packages", () => {
  it("resolves plain paths to directories, classifying the rest by shape", async () => {
    const main = goFile("main.go", {
      imports: [
        { specifier: "utils" },
        { specifier: "fmt" },
        { specifier: "github.com/x/y/z/w" },
        { specifier: "gopkg.in/yaml.v3" },
        { specifier: "C" },
      ],
    });
    const utils = goFile("utils/u.go", { defs: { Do: "function" } });
    const { result } = await run([main, utils]);
    const src = file("main.go");
    expect(edgeBetween(result.imports, src, "mod:go:utils")).toMatchObject({
      confidence: "inferred",
    });
    expect(edgeBetween(result.imports, src, "ext:go:stdlib")?.confidence).toBe("inferred");
    expect(edgeBetween(result.imports, src, "ext:go:github.com/x/y")).toBeDefined();
    expect(edgeBetween(result.imports, src, "ext:go:gopkg.in/yaml.v3")).toBeDefined();
    expect(edgeBetween(result.imports, src, "ext:go:cgo")).toBeDefined();
    expect((result.modules ?? []).map((m) => m.id)).toEqual(["mod:go:.", "mod:go:utils"]);
  });

  it("an import that matches a directory beats the stdlib shape rule", async () => {
    const main = goFile("main.go", { imports: [{ specifier: "errors" }] });
    const errors = goFile("errors/e.go", { defs: { New: "function" } });
    const { result } = await run([main, errors]);
    expect(edgeBetween(result.imports, file("main.go"), "mod:go:errors")).toBeDefined();
    expect(result.imports.some((e) => e.dst === "ext:go:stdlib")).toBe(false);
  });

  it("an external test package imports the package under test", async () => {
    const lib = goFile("lib/lib.go", { defs: { Add: "function" } });
    const ext = goFile("lib/lib_test.go", {
      pkg: "lib_test",
      defs: { TestAdd: "function" },
      imports: [{ specifier: "example.com/m/lib" }],
      refs: [{ name: "Add", receiver: "lib", receiverKind: "identifier", fromLocalId: "TestAdd" }],
    });
    const { result } = await run([lib, ext], { "go.mod": "module example.com/m\n" });
    expect(
      edgeBetween(result.imports, file("lib/lib_test.go"), "mod:go:example.com/m/lib"),
    ).toBeDefined();
    expect(
      edgeBetween(result.edges, sym("lib/lib_test.go", "TestAdd"), sym("lib/lib.go", "Add")),
    ).toBeDefined();
    // one module node for the directory, though it holds two packages
    expect((result.modules ?? []).map((m) => m.id)).toEqual(["mod:go:example.com/m/lib"]);
  });
});

describe("classifyImport and packageNameGuesses", () => {
  const table = tableFromDirs(["pkg"]);
  const required = new Set(["github.com/spf13/cobra", "k8s.io/api"]);
  const all = () => true;

  it("classifies by layout, then shape", () => {
    expect(classifyImport("pkg", table, required, all)).toMatchObject({ kind: "internal" });
    expect(classifyImport("pkg", table, required, () => false)).toEqual({ kind: "stdlib" });
    expect(classifyImport("net/http", table, required, all)).toEqual({ kind: "stdlib" });
    expect(classifyImport("github.com/spf13/cobra/doc", table, required, all)).toEqual({
      kind: "external",
      module: "github.com/spf13/cobra",
    });
    expect(classifyImport("k8s.io/api/core/v1", table, required, all)).toEqual({
      kind: "external",
      module: "k8s.io/api",
    });
    expect(classifyImport("go.uber.org/zap", table, required, all)).toEqual({
      kind: "external",
      module: "go.uber.org/zap",
    });
  });

  it("guesses package names from the last segment", () => {
    expect(packageNameGuesses("math/rand/v2")).toEqual(["rand"]);
    expect(packageNameGuesses("gopkg.in/yaml.v3")).toEqual(["yaml.v3", "yaml"]);
    expect(packageNameGuesses("github.com/foo/go-redis")).toEqual(["go-redis", "redis"]);
    expect(packageNameGuesses("github.com/foo/bar-go")).toEqual(["bar-go", "bar"]);
  });
});

describe("determinism", () => {
  it("gives the same result for any extraction order", async () => {
    const forward = await run(repo(), { "go.mod": GO_MOD });
    const reversed = await run([...repo()].reverse(), { "go.mod": GO_MOD });
    expect(JSON.stringify(reversed.result)).toBe(JSON.stringify(forward.result));
  });
});
