import { describe, expect, it } from "vitest";
import { typescriptPlugin } from "../src/index.ts";
import { memoryContext } from "./memory-repo.ts";

async function analyze(files: Record<string, string>) {
  const ctx = memoryContext(files);
  const info = (await typescriptPlugin.prepare?.(ctx)) ?? {};
  const result = await typescriptPlugin.analyzeProject?.(ctx, info);
  if (!result) throw new Error("analyzeProject missing");
  const defs = (file: string) => result.extractions.find((e) => e.file === file)?.definitions ?? [];
  const has = (src: string, dst: string, kind: string) =>
    [...result.resolution.edges, ...result.resolution.imports].some(
      (e) => e.src === src && e.dst === dst && e.kind === kind,
    );
  return { ...result, defs, has };
}

describe("definitions", () => {
  it("builds dotted localIds, kinds, parents and metadata", async () => {
    const { defs } = await analyze({
      "a.ts": [
        "export class Box<T> extends Base {",
        "  static make(): Box<number> { return new Box(); }",
        "  private async load(x: number): Promise<void> {}",
        "  get size() { return 1; }",
        "  handler = () => 1;",
        "}",
        "class Base {}",
        "export interface Shape { area(): number }",
        "export function outer() { function inner() {} const arrow = () => {}; }",
        "export const fn = function () {};",
        "const obj = { method() { return 1; }, arrow: () => 2 };",
        "namespace NS { export function inNs() {} }",
        "function local() {}",
        "export { local };",
      ].join("\n"),
    });
    const byId = new Map(defs("a.ts").map((d) => [d.localId, d]));
    expect([...byId.keys()].sort()).toEqual(
      [
        "Base",
        "Box",
        "Box.handler",
        "Box.load",
        "Box.make",
        "NS.inNs",
        "Shape",
        "fn",
        "local",
        "outer",
        "outer.arrow",
        "outer.inner",
      ].sort(),
    );
    expect(byId.get("Box")).toMatchObject({ kind: "class", meta: { isExported: true } });
    expect(byId.get("Box")?.signature).toBe("export class Box<T> extends Base");
    expect(byId.get("Box.make")).toMatchObject({
      kind: "method",
      parentLocalId: "Box",
      meta: { isStatic: true, visibility: "public" },
    });
    expect(byId.get("Box.load")).toMatchObject({
      meta: { isAsync: true, visibility: "private", isExported: false },
    });
    expect(byId.get("Shape")?.kind).toBe("interface");
    expect(byId.get("outer.inner")).toMatchObject({ kind: "function", parentLocalId: "outer" });
    expect(byId.get("fn")).toMatchObject({ kind: "function", meta: { isExported: true } });
    expect(byId.get("fn")?.signature).toBe("export const fn = function ()");
    expect(byId.get("local")?.meta?.isExported).toBe(true); // via `export { local }`
    expect(byId.get("Base")?.meta?.isExported).toBe(false);
    expect(byId.get("Box")?.span.startLine).toBe(1);
    expect(byId.get("Box")?.span.endLine).toBe(6);
  });

  it("skips overload signatures and disambiguates colliding localIds by line", async () => {
    const { defs } = await analyze({
      "a.ts": [
        "export function f(a: string): string;",
        "export function f(a: number): number;",
        "export function f(a: unknown): unknown { return a; }",
        "function dup() {}",
        "function dup() {}",
        "class K { constructor(a: string); constructor(a: number); constructor(a: unknown) {} }",
      ].join("\n"),
    });
    expect(defs("a.ts").map((d) => d.localId)).toEqual(["f", "dup", "dup@5", "K", "K.constructor"]);
    expect(defs("a.ts").find((d) => d.localId === "K.constructor")?.name).toBe("constructor");
  });

  it("truncates long signatures to 300 characters on one line", async () => {
    const params = Array.from({ length: 80 }, (_, i) => `argument${i}: number`).join(",\n  ");
    const { defs } = await analyze({ "a.ts": `function wide(${params}) {}` });
    const sig = defs("a.ts")[0]?.signature ?? "";
    expect(sig.length).toBeLessThanOrEqual(300);
    expect(sig).not.toContain("\n");
  });
});

describe("edges", () => {
  it("resolves calls through aliased imports and re-exports, and ignores library calls", async () => {
    const { has, resolution } = await analyze({
      "lib.ts": "export function work() {}",
      "barrel.ts": 'export * from "./lib";',
      "use.ts": [
        'import { work as w } from "./barrel";',
        "export function go() { w(); [1].map((x) => x); }",
      ].join("\n"),
    });
    expect(has("sym:use.ts#go", "sym:lib.ts#work", "calls")).toBe(true);
    expect(has("file:use.ts", "file:barrel.ts", "imports")).toBe(true);
    expect(has("file:barrel.ts", "file:lib.ts", "imports")).toBe(true);
    expect(resolution.unresolved).toEqual([]);
    // `[1].map(...)` is a library call: no edge and not unresolved.
    expect(resolution.edges.filter((e) => e.kind === "calls")).toHaveLength(1);
  });

  it("attributes calls in object-literal methods and top-level code correctly", async () => {
    const { has } = await analyze({
      "a.ts": [
        "function target() {}",
        "export function host() { const o = { m() { target(); } }; return o; }",
        "target();",
      ].join("\n"),
    });
    expect(has("sym:a.ts#host", "sym:a.ts#target", "calls")).toBe(true);
    expect(has("file:a.ts", "sym:a.ts#target", "calls")).toBe(true);
  });

  it("emits references for type annotations, new without constructor, and JSX components", async () => {
    const { has } = await analyze({
      "a.tsx": [
        "export class Model {}",
        "export interface Props { m: Model }",
        "export function Comp(p: Props) { return null; }",
        "export function make(m: Model) { return new Model(); }",
        "export const View = () => <Comp m={new Model()} />;",
      ].join("\n"),
    });
    expect(has("sym:a.tsx#make", "sym:a.tsx#Model", "references")).toBe(true);
    expect(has("sym:a.tsx#Props", "sym:a.tsx#Model", "references")).toBe(true);
    expect(has("sym:a.tsx#Comp", "sym:a.tsx#Props", "references")).toBe(true);
    expect(has("sym:a.tsx#View", "sym:a.tsx#Comp", "calls")).toBe(true);
  });

  it("resolves super.method() and inherited calls", async () => {
    const { has } = await analyze({
      "a.ts": [
        "class A { hi() {} }",
        "class B extends A { hi() { super.hi(); } run() { this.hi(); } }",
        "class C extends B { go() { this.run(); } }",
      ].join("\n"),
    });
    expect(has("sym:a.ts#B.hi", "sym:a.ts#A.hi", "calls")).toBe(true);
    expect(has("sym:a.ts#B.run", "sym:a.ts#B.hi", "calls")).toBe(true);
    expect(has("sym:a.ts#C.go", "sym:a.ts#B.run", "calls")).toBe(true);
    expect(has("sym:a.ts#B", "sym:a.ts#A", "extends")).toBe(true);
  });
});

describe("imports", () => {
  it("classifies relative, builtin, npm, dynamic, type-only and re-export imports", async () => {
    const { resolution, extractions } = await analyze({
      "a.ts": [
        'import fs from "fs";',
        'import { join } from "node:path";',
        'import chunk from "lodash/chunk";',
        'import "reflect-metadata";',
        'import type { T } from "./types";',
        'import * as ns from "./types";',
        'export { T as U } from "./types";',
        'export async function lazy() { return import("./types"); }',
        'import missing from "./nope";',
        'import alias from "@/not-mapped";',
        "export const x = [fs, join, chunk, ns, alias, missing];",
      ].join("\n"),
      "types.ts": "export type T = string;",
    });
    const imports = resolution.imports;
    const from = (dst: string) => imports.filter((e) => e.src === "file:a.ts" && e.dst === dst);

    const builtin = from("ext:node:builtins");
    expect(builtin).toHaveLength(1);
    expect(builtin[0]?.meta).toMatchObject({ package: "fs", packages: ["fs", "node:path"] });
    expect(from("ext:npm:lodash")).toHaveLength(1);
    expect(from("ext:npm:reflect-metadata")).toHaveLength(1);
    // Four imports of ./types collapse into one edge; not every one is type-only or dynamic.
    const types = from("file:types.ts");
    expect(types).toHaveLength(1);
    expect(types[0]?.meta?.isTypeOnly).toBeUndefined();
    expect(types[0]?.meta?.isDynamic).toBeUndefined();

    expect(resolution.externals.map((e) => e.id)).toEqual([
      "ext:node:builtins",
      "ext:npm:lodash",
      "ext:npm:reflect-metadata",
    ]);
    expect(resolution.unresolved.filter((u) => u.kind === "import").map((u) => u.name)).toEqual([
      "./nope",
      "@/not-mapped",
    ]);

    const raw = extractions.find((e) => e.file === "a.ts")?.imports ?? [];
    expect(raw.find((r) => r.specifier === "reflect-metadata")?.kind).toBe("side-effect");
    expect(raw.find((r) => r.specifier === "lodash/chunk")?.kind).toBe("module");
    expect(raw.find((r) => r.kind === "wildcard")?.alias).toBe("ns");
    expect(raw.some((r) => r.kind === "dynamic" && r.specifier === "./types")).toBe(true);
    expect(raw.find((r) => r.specifier === "./types")?.isRelative).toBe(true);
  });

  it("marks an import edge dynamic only when every import of it is dynamic", async () => {
    const { resolution } = await analyze({
      "a.ts": 'export const load = () => import("./b");',
      "b.ts": "export {};",
    });
    expect(resolution.imports[0]?.meta?.isDynamic).toBe(true);
  });
});

describe("robustness and the per-file API", () => {
  it("counts syntax errors and still extracts what parses", async () => {
    const { extractions } = await analyze({ "bad.ts": "export function ok() {}\nfunction (((" });
    expect(extractions[0]?.parseErrors).toBeGreaterThan(0);
    expect(extractions[0]?.definitions.map((d) => d.localId)).toContain("ok");
  });

  it("extract() parses a single file standalone and resolve() adds nothing", async () => {
    const content = 'import { x } from "./x";\nexport class C { m() { x(); this.n(); } n() {} }';
    const out = await typescriptPlugin.extract(
      { path: "c.ts", bytes: content.length, content, language: "typescript" },
      {},
    );
    expect(out.definitions.map((d) => d.localId)).toEqual(["C", "C.m", "C.n"]);
    expect(out.imports[0]).toMatchObject({ specifier: "./x", kind: "named" });
    expect(out.references.map((r) => [r.name, r.fromLocalId, r.receiverKind])).toEqual([
      ["x", "C.m", undefined],
      ["n", "C.m", "self"],
    ]);
    const empty = await typescriptPlugin.resolve({
      extractions: [out],
      index: {} as never,
      info: {},
      repo: memoryContext({}).repo,
    });
    expect(empty).toEqual({ imports: [], edges: [], externals: [], unresolved: [] });
  });

  it("marks definitions in test paths as tests", async () => {
    const { defs } = await analyze({
      "src/__tests__/a.ts": "export function t() {}",
      "src/a.spec.ts": "export function s() {}",
    });
    expect(defs("src/__tests__/a.ts")[0]?.meta?.isTest).toBe(true);
    expect(defs("src/a.spec.ts")[0]?.meta?.isTest).toBe(true);
  });
});
