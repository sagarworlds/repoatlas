import { describe, expect, it } from "vitest";
import { typescriptPlugin } from "../src/index.ts";
import { memoryContext } from "./memory-repo.ts";

async function analyze(files: Record<string, string>) {
  const ctx = memoryContext(files);
  const info = (await typescriptPlugin.prepare?.(ctx)) ?? {};
  const result = await typescriptPlugin.analyzeProject?.(ctx, info);
  if (!result) throw new Error("analyzeProject missing");
  const all = [...result.resolution.edges, ...result.resolution.imports];
  const has = (src: string, dst: string, kind: string) =>
    all.some((e) => e.src === src && e.dst === dst && e.kind === kind);
  return { ...result, all, has };
}

describe("workspace packages resolve for the type checker (calls, not only imports)", () => {
  const files = {
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/a/package.json": JSON.stringify({ name: "@w/a" }),
    "packages/a/src/index.ts": "export function a(): void {}\nexport class Base {}\n",
    "packages/a/src/extra.ts": "export function extra(): void {}\n",
    "packages/b/package.json": JSON.stringify({ name: "@w/b" }),
    "packages/b/src/index.ts": [
      'import { a, Base } from "@w/a";',
      'import { extra } from "@w/a/extra";',
      "export class Derived extends Base {}",
      "export function b(): void { a(); extra(); }",
    ].join("\n"),
  };

  it("emits cross-package calls and extends edges", async () => {
    const { has } = await analyze(files);
    expect(has("sym:packages/b/src/index.ts#b", "sym:packages/a/src/index.ts#a", "calls")).toBe(
      true,
    );
    expect(has("sym:packages/b/src/index.ts#b", "sym:packages/a/src/extra.ts#extra", "calls")).toBe(
      true,
    );
    expect(
      has("sym:packages/b/src/index.ts#Derived", "sym:packages/a/src/index.ts#Base", "extends"),
    ).toBe(true);
    expect(has("file:packages/b/src/index.ts", "file:packages/a/src/index.ts", "imports")).toBe(
      true,
    );
  });
});

describe("one pathological file does not fail the project", () => {
  it("handles a 5000-term binary expression chain without a stack overflow", async () => {
    const terms = Array.from({ length: 5000 }, (_, i) => `"x${i}"`).join(" +\n  ");
    const { has, extractions } = await analyze({
      "src/big.ts": `export function f(): void {}\nexport const s = ${terms};\n`,
      "src/ok.ts": 'import { f } from "./big";\nexport function h(): void { f(); }\n',
    });
    expect(has("sym:src/ok.ts#h", "sym:src/big.ts#f", "calls")).toBe(true);
    const big = extractions.find((e) => e.file === "src/big.ts");
    expect(big?.definitions.map((d) => d.localId)).toContain("f");
  });
});

describe("tsconfig paths inherited from an extended config in a subdirectory", () => {
  it("resolves relative to the config that declared them", async () => {
    const { has, all } = await analyze({
      "tsconfig.json": JSON.stringify({ extends: "./config/base.json" }),
      "config/base.json": JSON.stringify({
        compilerOptions: { paths: { "@x/*": ["../src/lib/*"] } },
      }),
      "src/lib/util.ts": "export function util(): void {}\n",
      "src/main.ts": 'import { util } from "@x/util";\nexport function main(): void { util(); }\n',
    });
    expect(has("file:src/main.ts", "file:src/lib/util.ts", "imports")).toBe(true);
    expect(has("sym:src/main.ts#main", "sym:src/lib/util.ts#util", "calls")).toBe(true);
    expect(all.some((e) => e.dst.startsWith("ext:npm:@x"))).toBe(false);
  });
});

describe("edge attribution rules", () => {
  it("attributes class-body code (property initializers, accessors) to the file, not the class", async () => {
    const { all, has } = await analyze({
      "a.ts": [
        "function target(): number { return 1; }",
        "export class C { static s = target(); get g() { return target(); } }",
      ].join("\n"),
    });
    expect(all.some((e) => e.kind === "calls" && e.src === "sym:a.ts#C")).toBe(false);
    expect(has("file:a.ts", "sym:a.ts#target", "calls")).toBe(true);
  });

  it("keeps method callers as the method", async () => {
    const { has } = await analyze({
      "a.ts": [
        "function target(): number { return 1; }",
        "export class C { m() { return target(); } }",
      ].join("\n"),
    });
    expect(has("sym:a.ts#C.m", "sym:a.ts#target", "calls")).toBe(true);
  });

  it("new Derived() without an own constructor references Derived, not the base constructor", async () => {
    const { has, all } = await analyze({
      "a.ts": [
        "export class A { constructor(public n: number) {} }",
        "export class B extends A {}",
        "export class D { constructor() {} }",
        "export function run(): void { new B(1); new D(); }",
      ].join("\n"),
    });
    expect(has("sym:a.ts#run", "sym:a.ts#B", "references")).toBe(true);
    expect(has("sym:a.ts#run", "sym:a.ts#A.constructor", "calls")).toBe(false);
    // A class that has its own constructor still gets a calls edge to it.
    expect(has("sym:a.ts#run", "sym:a.ts#D.constructor", "calls")).toBe(true);
    expect(all.length).toBeGreaterThan(0);
  });
});
