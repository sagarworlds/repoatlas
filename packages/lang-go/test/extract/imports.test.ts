import { describe, expect, it } from "vitest";
import { extract, importOf } from "./helpers.ts";

describe("go imports", () => {
  it("extracts single and block imports with lines", async () => {
    const ex = await extract(`package p

import "fmt"

import (
	"net/http"
	str "strings"
	. "example.com/m/dot"
	_ "example.com/m/side"
	"github.com/x/y/v2"
)
`);
    expect(ex.parseErrors).toBe(0);
    expect(ex.imports.map((i) => i.specifier)).toEqual([
      "fmt",
      "net/http",
      "strings",
      "example.com/m/dot",
      "example.com/m/side",
      "github.com/x/y/v2",
    ]);
    expect(importOf(ex, "fmt")).toMatchObject({ kind: "module", line: 3 });
    expect(importOf(ex, "net/http")).toMatchObject({ kind: "module", line: 6 });
    expect(importOf(ex, "net/http").alias).toBeUndefined();
    expect(importOf(ex, "strings")).toMatchObject({ kind: "module", alias: "str", line: 7 });
    expect(importOf(ex, "example.com/m/dot").kind).toBe("wildcard");
    expect(importOf(ex, "example.com/m/side").kind).toBe("side-effect");
    expect(importOf(ex, "github.com/x/y/v2").kind).toBe("module");
    expect(ex.imports.every((i) => i.isRelative === false)).toBe(true);
  });

  it("supports raw string import paths", async () => {
    const ex = await extract("package p\nimport `fmt`\n");
    expect(ex.imports.map((i) => i.specifier)).toEqual(["fmt"]);
  });

  it("drops cgo import C and records it in the file meta", async () => {
    const ex = await extract('package p\n\n/*\n#include <stdio.h>\n*/\nimport "C"\nimport "os"\n');
    expect(ex.imports.map((i) => i.specifier)).toEqual(["os"]);
    expect(ex.meta?.["go.cgo"]).toBe(true);
  });

  it("handles a file with only a package clause", async () => {
    const ex = await extract("package empty\n");
    expect(ex).toMatchObject({ definitions: [], imports: [], references: [], parseErrors: 0 });
    expect(ex.meta).toEqual({ "go.package": "empty" });
  });
});
