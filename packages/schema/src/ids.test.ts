import { describe, expect, it } from "vitest";
import {
  dirId,
  disambiguateLocalIds,
  externalId,
  fileId,
  isSafeRelativePath,
  moduleId,
  npmPackageName,
  parseId,
  repoId,
  symbolId,
  toPosixPath,
} from "./ids.ts";

describe("toPosixPath", () => {
  it("converts backslashes and strips ./ and trailing slash", () => {
    expect(toPosixPath("src\\app\\models.py")).toBe("src/app/models.py");
    expect(toPosixPath("./src/app/")).toBe("src/app");
    expect(toPosixPath(".")).toBe("");
  });
});

describe("isSafeRelativePath", () => {
  it("accepts clean relative paths", () => {
    expect(isSafeRelativePath("src/a.ts")).toBe(true);
  });
  it.each(["../x", "a/../b", "/etc/passwd", "C:/x", "a\\b", "a\0b", "./a"])("rejects %j", (p) => {
    expect(isSafeRelativePath(p)).toBe(false);
  });
});

describe("id builders", () => {
  it("builds the documented formats", () => {
    expect(repoId()).toBe("repo:");
    expect(dirId("")).toBe("dir:");
    expect(dirId("src/app")).toBe("dir:src/app");
    expect(fileId("src\\app\\models.py")).toBe("file:src/app/models.py");
    expect(moduleId("go", "github.com/acme/api/server")).toBe("mod:go:github.com/acme/api/server");
    expect(symbolId("src/app/models.py", "User.save")).toBe("sym:src/app/models.py#User.save");
    expect(externalId("pypi", "requests")).toBe("ext:pypi:requests");
    expect(externalId("npm", "@scope/pkg")).toBe("ext:npm:@scope/pkg");
  });
});

describe("disambiguateLocalIds", () => {
  it("keeps the first and suffixes later collisions with @line", () => {
    const out = disambiguateLocalIds([
      { localId: "Foo.bar", startLine: 10 },
      { localId: "Foo.bar", startLine: 42 },
      { localId: "Foo.baz", startLine: 50 },
    ]);
    expect(out).toEqual(["Foo.bar", "Foo.bar@42", "Foo.baz"]);
  });
  it("stays unique even when line numbers repeat", () => {
    const out = disambiguateLocalIds([
      { localId: "a", startLine: 1 },
      { localId: "a", startLine: 5 },
      { localId: "a", startLine: 5 },
    ]);
    expect(new Set(out).size).toBe(3);
  });
});

describe("npmPackageName", () => {
  it.each([
    ["lodash", "lodash"],
    ["lodash/fp", "lodash"],
    ["@scope/pkg", "@scope/pkg"],
    ["@scope/pkg/sub/path", "@scope/pkg"],
  ])("%s -> %s", (input, expected) => {
    expect(npmPackageName(input)).toBe(expected);
  });
});

describe("parseId", () => {
  it("round-trips every kind", () => {
    expect(parseId(repoId())).toEqual({ kind: "repo" });
    expect(parseId(dirId("a/b"))).toEqual({ kind: "dir", path: "a/b" });
    expect(parseId(fileId("a/b.ts"))).toEqual({ kind: "file", path: "a/b.ts" });
    expect(parseId(moduleId("go", "x/y"))).toEqual({
      kind: "module",
      language: "go",
      qualified: "x/y",
    });
    expect(parseId(symbolId("a.ts", "A.b"))).toEqual({
      kind: "symbol",
      path: "a.ts",
      qualifiedInFile: "A.b",
    });
    expect(parseId(externalId("npm", "@s/p"))).toEqual({
      kind: "external",
      ecosystem: "npm",
      pkg: "@s/p",
    });
  });
  it("returns undefined for malformed IDs", () => {
    expect(parseId("nope")).toBeUndefined();
    expect(parseId("sym:no-hash")).toBeUndefined();
  });

  it("disambiguates many same-line duplicates in linear time", () => {
    const items = Array.from({ length: 30_000 }, () => ({ localId: "A.m", startLine: 1 }));
    const started = Date.now();
    const ids = disambiguateLocalIds(items);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(new Set(ids).size).toBe(items.length);
    expect(ids.slice(0, 4)).toEqual(["A.m", "A.m@1", "A.m@1_2", "A.m@1_3"]);
  });
});
