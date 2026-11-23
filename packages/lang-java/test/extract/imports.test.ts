import { describe, expect, it } from "vitest";
import { extract } from "./helpers.ts";

describe("java imports", () => {
  it("handles single-type, on-demand and both static forms", async () => {
    const ex = await extract(`package p;

import a.b.C;
import a.b.*;
import static a.b.D.m;
import static a.b.E.*;
import Top;
import java.util.
    List;

class X {}
`);
    expect(ex.imports.map((i) => ({ s: i.specifier, k: i.kind, l: i.line, n: i.names }))).toEqual([
      { s: "a.b.C", k: "module", l: 3, n: undefined },
      { s: "a.b", k: "wildcard", l: 4, n: undefined },
      { s: "a.b.D", k: "named", l: 5, n: [{ name: "m" }] },
      { s: "a.b.E", k: "wildcard", l: 6, n: undefined },
      { s: "Top", k: "module", l: 7, n: undefined },
      { s: "java.util.List", k: "module", l: 8, n: undefined },
    ]);
    expect(ex.imports.every((i) => !i.isRelative)).toBe(true);
  });

  it("merges nothing across statements", async () => {
    const ex = await extract("import static a.D.m;\nimport static a.D.n;\nclass X {}\n");
    expect(ex.imports).toHaveLength(2);
    expect(ex.imports.map((i) => i.names?.[0]?.name)).toEqual(["m", "n"]);
  });
});
