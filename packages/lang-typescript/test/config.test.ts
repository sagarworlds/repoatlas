import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  applyCompilerOverrides,
  buildWorkspacePackages,
  externalTargetFor,
  isNodeBuiltin,
  parsePackageJsonWorkspaces,
  parsePnpmWorkspaceGlobs,
  readTsconfigOptions,
  resolveWorkspaceImport,
  typescriptPlugin,
} from "../src/index.ts";
import { memoryRepo } from "./memory-repo.ts";

describe("npm package names and builtins", () => {
  it("strips subpaths and keeps scopes", () => {
    expect(externalTargetFor("lodash/fp")).toMatchObject({ kind: "npm", id: "ext:npm:lodash" });
    expect(externalTargetFor("@scope/pkg/deep/file")).toMatchObject({
      kind: "npm",
      id: "ext:npm:@scope/pkg",
      name: "@scope/pkg",
    });
    expect(externalTargetFor("react")).toMatchObject({ id: "ext:npm:react" });
  });

  it("detects node builtins with and without the node: prefix", () => {
    for (const s of ["fs", "node:fs", "fs/promises", "path", "node:test", "child_process"]) {
      expect(isNodeBuiltin(s), s).toBe(true);
      expect(externalTargetFor(s)).toMatchObject({ kind: "builtin", id: "ext:node:builtins" });
    }
    expect(isNodeBuiltin("lodash")).toBe(false);
    expect(isNodeBuiltin("fsevents")).toBe(false);
  });

  it("refuses to invent packages for aliases and urls", () => {
    expect(externalTargetFor("@/utils")).toBeUndefined();
    expect(externalTargetFor("#internal")).toBeUndefined();
    expect(externalTargetFor("./local")).toBeUndefined();
  });
});

describe("tsconfig overrides", () => {
  it("forces analysis-only options and drops plugins/typeRoots", () => {
    const out = applyCompilerOverrides({
      noEmit: false,
      allowJs: true,
      skipLibCheck: false,
      types: ["node"],
      typeRoots: ["./types"],
      outDir: "dist",
      plugins: [{ name: "x" }],
      strict: true,
      paths: { "@a/*": ["src/a/*"] },
    });
    expect(out.noEmit).toBe(true);
    expect(out.allowJs).toBe(true);
    expect(out.checkJs).toBe(false);
    expect(out.maxNodeModuleJsDepth).toBe(0);
    expect(out.skipLibCheck).toBe(true);
    expect(out.types).toEqual([]);
    expect(out.typeRoots).toBeUndefined();
    expect(out.outDir).toBeUndefined();
    expect(out.plugins).toBeUndefined();
    // Kept from the project:
    expect(out.strict).toBe(true);
    expect(out.paths).toEqual({ "@a/*": ["src/a/*"] });
  });

  it("uses defaults when there is no tsconfig, and does not mutate the input", () => {
    const input: ts.CompilerOptions = { target: ts.ScriptTarget.ES2015 };
    const out = applyCompilerOverrides(input);
    expect(input).toEqual({ target: ts.ScriptTarget.ES2015 });
    expect(out.target).toBe(ts.ScriptTarget.ES2015);
    const defaults = applyCompilerOverrides(undefined);
    expect(defaults.target).toBe(ts.ScriptTarget.ES2022);
    expect(defaults.moduleResolution).toBe(ts.ModuleResolutionKind.Bundler);
    expect(defaults.jsx).toBe(ts.JsxEmit.Preserve);
  });

  it("reads tsconfig.json with comments and relative extends through RepoView", () => {
    const repo = memoryRepo({
      "tsconfig.base.json": '{ "compilerOptions": { "strict": true, "target": "ES2020" } }',
      "tsconfig.json": `{
        // comment
        "extends": "./tsconfig.base.json",
        "compilerOptions": { "paths": { "@x/*": ["./x/*"] }, },
      }`,
    });
    const { options, tsconfigPath } = readTsconfigOptions(repo);
    expect(tsconfigPath).toBe("tsconfig.json");
    expect(options.strict).toBe(true);
    expect(options.target).toBe(ts.ScriptTarget.ES2020);
    expect(options.paths).toEqual({ "@x/*": ["./x/*"] });
  });

  it("reads jsconfig.json when there is no tsconfig.json, and prefers tsconfig.json", () => {
    const js = readTsconfigOptions(
      memoryRepo({ "jsconfig.json": '{ "compilerOptions": { "baseUrl": "src" } }' }),
    );
    expect(js.tsconfigPath).toBe("jsconfig.json");
    expect(js.options.baseUrl).toBe("/repo/src");
    expect(js.options.allowJs).toBe(true);

    const both = readTsconfigOptions(
      memoryRepo({
        "jsconfig.json": '{ "compilerOptions": { "strict": true } }',
        "tsconfig.json": '{ "compilerOptions": { "strict": false } }',
      }),
    );
    expect(both.tsconfigPath).toBe("tsconfig.json");
    expect(both.options.strict).toBe(false);
  });

  it("survives a missing or broken tsconfig", () => {
    expect(readTsconfigOptions(memoryRepo({})).tsconfigPath).toBeUndefined();
    const broken = readTsconfigOptions(memoryRepo({ "tsconfig.json": "{ not json" }));
    expect(broken.options.noEmit).toBe(true);
  });
});

describe("workspace packages", () => {
  it("parses the simple pnpm-workspace.yaml form", () => {
    const yaml = [
      "# comment",
      "packages:",
      '  - "packages/*"',
      "  - apps/*   # trailing comment",
      "  - '!**/test/**'",
      "catalog:",
      "  - ignored",
      "",
    ].join("\n");
    expect(parsePnpmWorkspaceGlobs(yaml)).toEqual(["packages/*", "apps/*"]);
  });

  it("reads package.json workspaces as array or object", () => {
    expect(parsePackageJsonWorkspaces({ workspaces: ["a/*", "b"] })).toEqual(["a/*", "b"]);
    expect(parsePackageJsonWorkspaces({ workspaces: { packages: ["c/*"] } })).toEqual(["c/*"]);
    expect(parsePackageJsonWorkspaces({})).toEqual([]);
    expect(parsePackageJsonWorkspaces("nope")).toEqual([]);
  });

  const files = {
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "package.json": '{ "name": "root", "workspaces": ["tools/cli"] }',
    "packages/utils/package.json": '{ "name": "@acme/utils", "main": "dist/index.js" }',
    "packages/utils/src/index.ts": "export const u = 1;",
    "packages/utils/src/deep/thing.ts": "export const t = 1;",
    "packages/broken/package.json": "{ not json",
    "tools/cli/package.json": '{ "name": "acme-cli" }',
    "tools/cli/index.ts": "export {};",
  };

  it("builds the name -> directory map and ignores broken manifests", () => {
    expect(buildWorkspacePackages(memoryRepo(files))).toEqual({
      "@acme/utils": "packages/utils",
      "acme-cli": "tools/cli",
    });
  });

  it("resolves workspace imports to source files, mapping dist to src", () => {
    const repo = memoryRepo(files);
    const pkgs = buildWorkspacePackages(repo);
    expect(resolveWorkspaceImport(repo, pkgs, "@acme/utils")).toBe("packages/utils/src/index.ts");
    expect(resolveWorkspaceImport(repo, pkgs, "@acme/utils/deep/thing")).toBe(
      "packages/utils/src/deep/thing.ts",
    );
    expect(resolveWorkspaceImport(repo, pkgs, "acme-cli")).toBe("tools/cli/index.ts");
    expect(resolveWorkspaceImport(repo, pkgs, "@acme/other")).toBeUndefined();
  });
});

describe("typescriptPlugin.detect", () => {
  it("claims TypeScript and JavaScript sources but not declaration files", () => {
    const mk = (path: string) => ({ path, bytes: 1 });
    const claimed = typescriptPlugin
      .detect(
        [
          "a.ts",
          "b.tsx",
          "c.mts",
          "d.cts",
          "e.d.ts",
          "f.js",
          "g.d.mts",
          "h.json",
          "i.jsx",
          "j.mjs",
          "k.cjs",
        ].map(mk),
      )
      .map((f) => f.path);
    expect(claimed).toEqual(["a.ts", "b.tsx", "c.mts", "d.cts", "f.js", "i.jsx", "j.mjs", "k.cjs"]);
  });
});
