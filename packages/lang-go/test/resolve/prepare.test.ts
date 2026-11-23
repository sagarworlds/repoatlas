import { describe, expect, it } from "vitest";
import {
  computeGoProjectInfo,
  goPrepare,
  importPathForDir,
  parseGoMod,
  readGoProjectInfo,
  tableFromDirs,
  withDirs,
} from "../../src/prepare/index.ts";
import { projectContext } from "./helpers.ts";

describe("parseGoMod", () => {
  it("reads a plain module line", () => {
    expect(parseGoMod("module github.com/acme/api\n\ngo 1.22\n").modulePath).toBe(
      "github.com/acme/api",
    );
  });

  it("accepts quotes, raw quotes, comments, CRLF and a BOM", () => {
    expect(parseGoMod('module "example.com/q"').modulePath).toBe("example.com/q");
    expect(parseGoMod("module `example.com/raw`").modulePath).toBe("example.com/raw");
    expect(parseGoMod("module example.com/c // the module\n").modulePath).toBe("example.com/c");
    expect(parseGoMod("﻿module example.com/bom\r\ngo 1.21\r\n").modulePath).toBe("example.com/bom");
    expect(parseGoMod('// module fake\nmodule "a//b"').modulePath).toBe("a//b");
  });

  it("accepts the block form", () => {
    const text = "module (\n\t// the one\n\texample.com/blocked\n)\n";
    expect(parseGoMod(text).modulePath).toBe("example.com/blocked");
    expect(parseGoMod("module(\n example.com/glued\n)").modulePath).toBe("example.com/glued");
  });

  it("collects requires in single and block form, ignoring comments and other directives", () => {
    const text = [
      "module m",
      "require github.com/a/b v1.0.0",
      "require (",
      "\tgithub.com/c/d v2.1.0 // indirect",
      '\t"golang.org/x/net" v0.1.0',
      ")",
      "replace github.com/a/b => ../b",
      "exclude (",
      "\tgithub.com/z/z v1",
      ")",
      "retract v1.0.1",
    ].join("\n");
    const parsed = parseGoMod(text);
    expect(parsed.requires).toEqual(["github.com/a/b", "github.com/c/d", "golang.org/x/net"]);
  });

  it("never throws and returns no module for garbage or an empty file", () => {
    for (const text of ["", "   \n\n", "((((", "module", "module (", "\0\0", "require (", ")"]) {
      expect(() => parseGoMod(text)).not.toThrow();
    }
    expect(parseGoMod("").modulePath).toBeUndefined();
    expect(parseGoMod("module").modulePath).toBeUndefined();
    expect(parseGoMod("go 1.22").modulePath).toBeUndefined();
  });

  it("keeps the first module line", () => {
    expect(parseGoMod("module a\nmodule b").modulePath).toBe("a");
  });

  it("strips a trailing slash from the module path", () => {
    expect(parseGoMod("module example.com/x/").modulePath).toBe("example.com/x");
  });
});

describe("computeGoProjectInfo and goPrepare", () => {
  it("maps directories to import paths inside one module", async () => {
    const ctx = projectContext({
      "go.mod": "module github.com/acme/api\n",
      "main.go": "",
      "internal/server/server.go": "",
      "internal/server/server_test.go": "",
      "cmd/api/main.go": "",
    });
    const info = await goPrepare(ctx);
    expect(info.modules).toEqual([{ dir: "", path: "github.com/acme/api" }]);
    expect(info.dirToImportPath).toEqual({
      "": "github.com/acme/api",
      "cmd/api": "github.com/acme/api/cmd/api",
      "internal/server": "github.com/acme/api/internal/server",
    });
  });

  it("uses the longest go.mod ancestor for nested modules", async () => {
    const ctx = projectContext({
      "go.mod": "module example.com/root\n",
      "a.go": "",
      "tools/go.mod": "module example.com/tools\n",
      "tools/gen/gen.go": "",
      "tools/tools.go": "",
      "pkg/p.go": "",
    });
    const info = await goPrepare(ctx);
    expect(info.modules.map((m) => m.dir)).toEqual(["", "tools"]);
    expect(info.dirToImportPath["tools/gen"]).toBe("example.com/tools/gen");
    expect(info.dirToImportPath.tools).toBe("example.com/tools");
    expect(info.dirToImportPath.pkg).toBe("example.com/root/pkg");
    expect(info.dirToImportPath[""]).toBe("example.com/root");
  });

  it("finds a go.mod even when allFiles does not list it", async () => {
    const ctx = projectContext({ "svc/go.mod": "module example.com/svc\n", "svc/a/a.go": "" });
    ctx.allFiles = ctx.allFiles.filter((f) => !f.path.endsWith("go.mod"));
    const info = await goPrepare(ctx);
    expect(info.dirToImportPath["svc/a"]).toBe("example.com/svc/a");
  });

  it("uses plain directory paths in a module-less repo", async () => {
    const info = await goPrepare(
      projectContext({ "main.go": "", "util/u.go": "", "a/b/c.go": "" }),
    );
    expect(info.modules).toEqual([]);
    expect(info.dirToImportPath).toEqual({ "": ".", "a/b": "a/b", util: "util" });
  });

  it("falls back to directory paths outside every go.mod", async () => {
    const info = await goPrepare(
      projectContext({
        "sub/go.mod": "module example.com/sub\n",
        "sub/s.go": "",
        "other/o.go": "",
      }),
    );
    expect(info.dirToImportPath.sub).toBe("example.com/sub");
    expect(info.dirToImportPath.other).toBe("other");
  });

  it("ignores a go.mod without a module line and unreadable content", async () => {
    const info = await goPrepare(projectContext({ "go.mod": "go 1.22\n", "x/x.go": "" }));
    expect(info.modules).toEqual([]);
    expect(info.dirToImportPath.x).toBe("x");
  });

  it("collects required modules sorted and unique across go.mod files", () => {
    const info = computeGoProjectInfo(
      ["a.go", "b/b.go"],
      [
        { dir: "", text: "module a\nrequire (\n github.com/z/z v1\n github.com/a/a v1\n)" },
        { dir: "b", text: "module b\nrequire github.com/a/a v2" },
      ],
    );
    expect(info.requiredModules).toEqual(["github.com/a/a", "github.com/z/z"]);
  });

  it("is deterministic and JSON friendly", async () => {
    const files = { "go.mod": "module m\n", "b/b.go": "", "a/a.go": "", "c.go": "" };
    const one = await goPrepare(projectContext(files));
    const two = await goPrepare(projectContext(files));
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(Object.keys(one.dirToImportPath)).toEqual(["", "a", "b"]);
    expect(readGoProjectInfo(JSON.parse(JSON.stringify(one)))).toBeDefined();
  });
});

describe("readGoProjectInfo, tableFromDirs, withDirs", () => {
  it("rejects values that are not a GoProjectInfo", () => {
    expect(readGoProjectInfo(undefined)).toBeUndefined();
    expect(readGoProjectInfo({})).toBeUndefined();
    expect(readGoProjectInfo({ version: 2, modules: [], dirToImportPath: {} })).toBeUndefined();
    expect(
      readGoProjectInfo({ version: 1, modules: [{ dir: 1 }], dirToImportPath: {} }),
    ).toBeUndefined();
    expect(
      readGoProjectInfo({ version: 1, modules: [], dirToImportPath: { a: 1 } }),
    ).toBeUndefined();
  });

  it("builds the reverse map, with the first sorted directory winning a clash", () => {
    const table = readGoProjectInfo({
      version: 1,
      modules: [{ dir: "", path: "m" }],
      requiredModules: [],
      dirToImportPath: { b: "m/x", a: "m/x", c: "m/c" },
    });
    expect(table?.importPathToDir.get("m/x")).toBe("a");
    expect(table?.moduleDirs.has("c")).toBe(true);
  });

  it("derives a module-less table and extends a table with missing directories", () => {
    const table = tableFromDirs(["", "x/y"]);
    expect(table.importPathToDir.get("x/y")).toBe("x/y");
    expect(table.importPathToDir.get(".")).toBe("");
    expect(table.moduleDirs.size).toBe(0);
    const base = readGoProjectInfo({
      version: 1,
      modules: [{ dir: "", path: "m" }],
      requiredModules: [],
      dirToImportPath: { "": "m" },
    });
    if (base === undefined) throw new Error("expected a table");
    expect(withDirs(base, [""])).toBe(base);
    expect(withDirs(base, ["", "new"]).dirToImportPath.get("new")).toBe("m/new");
  });

  it("importPathForDir reports where the path came from", () => {
    expect(importPathForDir("a", [{ dir: "", path: "m" }])).toEqual({
      importPath: "m/a",
      viaModule: true,
    });
    expect(importPathForDir("", [])).toEqual({ importPath: ".", viaModule: false });
  });
});
