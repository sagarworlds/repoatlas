import type { ProjectContext } from "@repoatlas/plugin-api";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { typescriptPlugin } from "../src/index.ts";
import { classifyAssignmentTarget, collectCommonJsExportedNames } from "../src/js-patterns.ts";
import { isSupportedSource, languageOfSource } from "../src/source-kinds.ts";
import { memoryRepo } from "./memory-repo.ts";

/** Like memoryContext, but claims JavaScript files too (the pipeline does this via detect). */
async function analyze(files: Record<string, string>) {
  const repo = memoryRepo(files);
  const all = Object.keys(files).map((path) => ({ path, bytes: files[path]?.length ?? 0 }));
  const ctx: ProjectContext = {
    files: all.filter((f) => isSupportedSource(f.path)),
    allFiles: all,
    repo,
  };
  const info = (await typescriptPlugin.prepare?.(ctx)) ?? {};
  const result = await typescriptPlugin.analyzeProject?.(ctx, info);
  if (!result) throw new Error("analyzeProject missing");
  const all2 = [...result.resolution.edges, ...result.resolution.imports];
  return {
    ...result,
    extraction: (file: string) => result.extractions.find((e) => e.file === file),
    has: (src: string, dst: string, kind: string) =>
      all2.some((e) => e.src === src && e.dst === dst && e.kind === kind),
    edgesOfKind: (kind: string) => all2.filter((e) => e.kind === kind),
  };
}

function parseAssign(code: string): ts.BinaryExpression {
  const sf = ts.createSourceFile("a.js", code, ts.ScriptTarget.ES2022, true);
  const st = sf.statements[0];
  if (!st || !ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) {
    throw new Error("not an assignment");
  }
  return st.expression;
}

describe("source kinds", () => {
  it("maps extensions to languages", () => {
    expect(languageOfSource("a.js")).toBe("javascript");
    expect(languageOfSource("a.mjs")).toBe("javascript");
    expect(languageOfSource("a.jsx")).toBe("javascript");
    expect(languageOfSource("a.cjs")).toBe("javascript");
    expect(languageOfSource("a.ts")).toBe("typescript");
    expect(languageOfSource("a.tsx")).toBe("typescript");
  });
});

describe("assignment classification", () => {
  it("recognises CommonJS and prototype targets", () => {
    const kind = (code: string) => classifyAssignmentTarget(parseAssign(code).left);
    expect(kind("module.exports = 1")).toEqual({ kind: "module-exports" });
    expect(kind("exports.foo = 1")).toEqual({ kind: "export-member", name: "foo" });
    expect(kind("module.exports.foo = 1")).toEqual({ kind: "export-member", name: "foo" });
    expect(kind("Foo.prototype.bar = 1")).toEqual({
      kind: "prototype-member",
      owner: "Foo",
      name: "bar",
    });
    expect(kind("Foo.prototype = {}")).toEqual({ kind: "prototype", owner: "Foo" });
    expect(kind("Foo.make = 1")).toEqual({ kind: "static-member", owner: "Foo", name: "make" });
    expect(kind("a.b.c = 1")).toBeUndefined();
  });

  it("collects exported local names", () => {
    const sf = ts.createSourceFile(
      "a.js",
      "module.exports = { a, b: c, d: 1 };\nexports.e = f;\nmodule.exports.g = h;",
      ts.ScriptTarget.ES2022,
      true,
    );
    expect([...collectCommonJsExportedNames(sf)].sort()).toEqual(["a", "c", "f", "h"]);
  });
});

describe("JavaScript analysis", () => {
  it("resolves CommonJS requires, destructuring, aliases and index.js", async () => {
    const r = await analyze({
      "lib/index.js":
        "const { helper: h } = require('./util');\nexports.run = function run() { return h(); };",
      "lib/util.js": "function helper() { return 1; }\nmodule.exports = { helper };",
      "main.js":
        "const lib = require('./lib');\nfunction go() { return lib.run(); }\nmodule.exports = go;",
    });
    expect(r.has("file:main.js", "file:lib/index.js", "imports")).toBe(true);
    expect(r.has("file:lib/index.js", "file:lib/util.js", "imports")).toBe(true);
    expect(r.has("sym:main.js#go", "sym:lib/index.js#run", "calls")).toBe(true);
    expect(r.has("sym:lib/index.js#run", "sym:lib/util.js#helper", "calls")).toBe(true);
    expect(r.extraction("main.js")?.language).toBe("javascript");
  });

  it("maps externals and node builtins", async () => {
    const r = await analyze({
      "a.js":
        "const _ = require('lodash');\nconst fs = require('node:fs');\nconst p = require('path');\nfunction f() { return _.map([], fs.readFileSync); }",
    });
    expect(r.has("file:a.js", "ext:npm:lodash", "imports")).toBe(true);
    expect(r.has("file:a.js", "ext:node:builtins", "imports")).toBe(true);
    expect(r.edgesOfKind("calls").filter((e) => e.dst.startsWith("ext:"))).toEqual([]);
    expect(r.resolution.unresolved).toEqual([]);
  });

  it("records nothing for a require with a non-literal specifier", async () => {
    const r = await analyze({
      "a.js": "function load(name) { return require('./plugins/' + name); }",
      "plugins/x.js": "module.exports = 1;",
    });
    expect(r.edgesOfKind("imports")).toEqual([]);
    const imports = r.extraction("a.js")?.imports ?? [];
    expect(imports).toEqual([]);
  });

  it("supports ESM in .mjs and .cjs, JSX in .js, and extension-less requires", async () => {
    const r = await analyze({
      "m.mjs": "export function a() { return 1; }",
      "c.cjs": "exports.b = () => 2;",
      "use.js":
        "import { a as aa } from './m.mjs';\nconst { b } = require('./c.cjs');\nexport function u() { return aa() + b(); }\nexport const View = () => <div>{aa()}</div>;",
    });
    expect(r.has("sym:use.js#u", "sym:m.mjs#a", "calls")).toBe(true);
    expect(r.has("file:use.js", "file:c.cjs", "imports")).toBe(true);
    expect(r.has("sym:use.js#View", "sym:m.mjs#a", "calls")).toBe(true);
    expect(r.extraction("use.js")?.parseErrors).toBe(0);
  });

  it("creates nodes for prototype methods and function constructors", async () => {
    const r = await analyze({
      "c.js": [
        "function Counter() { this.n = 0; }",
        "Counter.prototype.inc = function () { this.n++; return this.report(); };",
        "Counter.prototype.report = function () { return this.n; };",
        "Counter.create = function () { return new Counter(); };",
        "module.exports = Counter;",
      ].join("\n"),
    });
    const defs = new Map((r.extraction("c.js")?.definitions ?? []).map((d) => [d.localId, d]));
    expect(defs.get("Counter")?.kind).toBe("function");
    expect(defs.get("Counter.inc")?.meta?.["js.isPrototypeMethod"]).toBe(true);
    expect(defs.get("Counter.create")?.meta?.isStatic).toBe(true);
    expect(r.has("sym:c.js#Counter.inc", "sym:c.js#Counter.report", "calls")).toBe(true);
    expect(r.has("sym:c.js#Counter.create", "sym:c.js#Counter", "calls")).toBe(true);
  });

  it("emits no edge and no unresolved entry for calls through untyped parameters", async () => {
    const r = await analyze({
      "a.js": "function run(cb, obj) { cb(); return obj.go(); }\nfunction go() {}",
    });
    expect(r.edgesOfKind("calls")).toEqual([]);
    expect(r.resolution.unresolved).toEqual([]);
  });

  it("infers receiver types from `new` and JSDoc", async () => {
    const r = await analyze({
      "db.js": "class Database { query() { return 1; } }\nmodule.exports = Database;",
      "a.js": [
        "const Database = require('./db');",
        "/** @param {Database} d */",
        "function viaDoc(d) { return d.query(); }",
        "function viaNew() { const db = new Database(); return db.query(); }",
      ].join("\n"),
    });
    expect(r.has("sym:a.js#viaNew", "sym:db.js#Database.query", "calls")).toBe(true);
    expect(r.has("sym:a.js#viaDoc", "sym:db.js#Database.query", "calls")).toBe(true);
  });

  it("works in a JavaScript-only repo with jsconfig.json paths", async () => {
    const r = await analyze({
      "jsconfig.json": '{ "compilerOptions": { "baseUrl": "src" } }',
      "src/util/x.js": "export function x() {}",
      "src/app.js": "import { x } from 'util/x';\nexport function app() { x(); }",
    });
    expect(r.has("file:src/app.js", "file:src/util/x.js", "imports")).toBe(true);
    expect(r.has("sym:src/app.js#app", "sym:src/util/x.js#x", "calls")).toBe(true);
  });

  it("reports parse errors per file without failing the others", async () => {
    const r = await analyze({
      "bad.js": "function ok() {}\nfunction broken( {",
      "good.js": "export function fine() {}",
    });
    expect(r.extraction("bad.js")?.parseErrors).toBeGreaterThan(0);
    expect(r.extraction("good.js")?.parseErrors).toBe(0);
    expect(r.extraction("bad.js")?.definitions.some((d) => d.localId === "ok")).toBe(true);
  });

  it("keeps TypeScript files typed as typescript next to JavaScript", async () => {
    const r = await analyze({
      "a.ts": "import { j } from './b.js';\nexport function t() { j(); }",
      "b.js": "export function j() {}",
    });
    expect(r.extraction("a.ts")?.language).toBe("typescript");
    expect(r.extraction("b.js")?.language).toBe("javascript");
    expect(r.has("sym:a.ts#t", "sym:b.js#j", "calls")).toBe(true);
  });

  it("resolves a call whose callee is a call result through the resolved signature", async () => {
    const r = await analyze({
      "boot.js": "module.exports = function boot(app) { return app; };",
      "a.js": "export function viaRequire() { return require('./boot.js')({}); }",
    });
    expect(r.has("sym:a.js#viaRequire", "sym:boot.js#boot", "calls")).toBe(true);
    expect(r.resolution.unresolved).toEqual([]);
  });

  it("does not count a call of a call result that is declared outside the graph", async () => {
    const r = await analyze({
      "types.d.ts": [
        "export interface Styler { (text: string): string; hex(c: string): Styler }",
        "export declare const styler: Styler;",
      ].join("\n"),
      "a.js": [
        "import { styler } from './types.js';",
        "export function paint() { return styler.hex('#fff')('x'); }",
      ].join("\n"),
    });
    expect(r.edgesOfKind("calls")).toEqual([]);
    expect(r.resolution.unresolved).toEqual([]);
  });
  it("resolves JavaScript workspace packages through their main entry", async () => {
    const r = await analyze({
      "package.json": '{"workspaces":["packages/*"]}',
      "packages/core/package.json": '{"name":"@x/core","main":"lib/index.js"}',
      "packages/core/lib/index.js": "exports.coreFn = function coreFn() {};",
      "packages/app/main.js":
        "const { coreFn } = require('@x/core');\nfunction m() { coreFn(); }\nmodule.exports = m;",
    });
    expect(r.has("file:packages/app/main.js", "file:packages/core/lib/index.js", "imports")).toBe(
      true,
    );
    expect(r.resolution.unresolved).toEqual([]);
  });

  it("prefers the .js implementation over a sibling .d.ts", async () => {
    const r = await analyze({
      "src/foo.js": "export function foo() {}\nexport function bar() { return foo(); }",
      "src/foo.d.ts": "export function foo(): void;\nexport function bar(): void;",
      "src/use.js": "import { foo, bar } from './foo';\nexport function go() { foo(); bar(); }",
    });
    expect(r.has("file:src/use.js", "file:src/foo.js", "imports")).toBe(true);
    expect(r.has("sym:src/use.js#go", "sym:src/foo.js#foo", "calls")).toBe(true);
    expect(r.has("sym:src/use.js#go", "sym:src/foo.js#bar", "calls")).toBe(true);
  });

  it("scans a file with many unclosed JSDoc openers in linear time", async () => {
    const started = Date.now();
    await analyze({
      "a.js": `export function f() {}
${'"/** a\n'.repeat(40_000)}`,
    });
    expect(Date.now() - started).toBeLessThan(8000);
  }, 30_000);
});
