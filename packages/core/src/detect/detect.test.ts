import type { LanguagePlugin, RepoFile } from "@repoatlas/plugin-api";
import { describe, expect, it } from "vitest";
import { createRegistry } from "../plugins/registry.ts";
import { assignFilesToPlugins } from "./assign.ts";
import { languageOfPath } from "./language.ts";

function fakePlugin(id: string, detect: (files: RepoFile[]) => RepoFile[]): LanguagePlugin {
  return {
    id,
    version: "1",
    languages: ["typescript"],
    tier: 1,
    detect,
    extract: async () => {
      throw new Error("not used");
    },
    resolve: async () => {
      throw new Error("not used");
    },
  };
}
const byExt =
  (ext: string) =>
  (files: RepoFile[]): RepoFile[] =>
    files.filter((f) => f.path.endsWith(ext));

describe("languageOfPath", () => {
  it.each([
    ["a.ts", "typescript"],
    ["a/b.tsx", "typescript"],
    ["a.mts", "typescript"],
    ["a.cjs", "javascript"],
    ["a.py", "python"],
    ["a.kts", "kotlin"],
    ["a.cs", "csharp"],
    ["a.h", "c"],
    ["a.hxx", "cpp"],
    ["A.PY", "python"],
  ])("%s -> %s", (path, lang) => {
    expect(languageOfPath(path)).toBe(lang);
  });
  it("excludes declaration files and unknown extensions", () => {
    expect(languageOfPath("types/index.d.ts")).toBeUndefined();
    expect(languageOfPath("x.d.mts")).toBeUndefined();
    expect(languageOfPath("README.md")).toBeUndefined();
    expect(languageOfPath("Makefile")).toBeUndefined();
  });
});

describe("assignFilesToPlugins", () => {
  const files: RepoFile[] = [
    { path: "a.ts", bytes: 1 },
    { path: "b.js", bytes: 1 },
    { path: "c.md", bytes: 1 },
  ];

  it("gives each file to the first claiming plugin", () => {
    const result = assignFilesToPlugins(files, [
      fakePlugin("one", byExt(".ts")),
      fakePlugin("greedy", (f) => f.filter((x) => x.path !== "c.md")),
    ]);
    expect(result.assignments.get("one")?.map((f) => f.path)).toEqual(["a.ts"]);
    expect(result.assignments.get("greedy")?.map((f) => f.path)).toEqual(["b.js"]);
    expect(result.unclaimed.map((f) => f.path)).toEqual(["c.md"]);
    expect(result.errors).toEqual([]);
  });

  it("skips a throwing plugin and reports it", () => {
    const result = assignFilesToPlugins(files, [
      fakePlugin("bad", () => {
        throw new Error("boom");
      }),
      fakePlugin("ts", byExt(".ts")),
    ]);
    expect(result.errors).toEqual([{ plugin: "bad", message: "boom" }]);
    expect(result.assignments.get("bad")).toEqual([]);
    expect(result.assignments.get("ts")?.map((f) => f.path)).toEqual(["a.ts"]);
  });
});

describe("createRegistry", () => {
  it("looks up plugins by id and rejects duplicates", () => {
    const a = fakePlugin("a", () => []);
    const registry = createRegistry([a]);
    expect(registry.byId("a")).toBe(a);
    expect(registry.byId("zzz")).toBeUndefined();
    expect(registry.plugins).toHaveLength(1);
    expect(() => createRegistry([a, fakePlugin("a", () => [])])).toThrow(/Duplicate/);
  });
});
