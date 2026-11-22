import type { FileExtraction, GraphEdge } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { extractPython } from "../../src/extract/index.ts";
import { parseIni } from "../../src/prepare/ini.ts";
import { run, sym } from "./helpers.ts";

async function analyse(files: Record<string, string>) {
  const extractions: FileExtraction[] = [];
  for (const [path, content] of Object.entries(files)) {
    extractions.push(await extractPython({ path, content }));
  }
  return run(extractions, {}, files);
}

function edgesFrom(edges: GraphEdge[], src: string): GraphEdge[] {
  return edges.filter((e) => e.kind === "calls" && e.src === src);
}

describe("relative imports at the top of the project", () => {
  it("treats `from . import core` in a root module as a sibling lookup", async () => {
    const { result } = await analyse({
      "__init__.py": "",
      "core.py": "def thing():\n    pass\n",
      "a.py": "from . import core\n\ndef t():\n    core.thing()\n",
    });
    expect(result.externals.map((e) => e.id)).not.toContain("ext:pypi:");
    expect(edgesFrom(result.edges, sym("a.py", "t")).map((e) => e.dst)).toContain(
      sym("core.py", "thing"),
    );
  });

  it("reports an import that climbs past the top package as unresolved, not external", async () => {
    const { result } = await analyse({
      "pk/__init__.py": "",
      "pk/a.py": "from .. import zzz\nfrom ..yy import q\n",
    });
    expect(result.externals).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.unresolved.map((u) => u.name).sort()).toEqual(["..", "..yy"]);
  });
});

describe("function-level imports", () => {
  it("keeps the import of each function for the same local name", async () => {
    const { result } = await analyse({
      "p/__init__.py": "",
      "p/x.py": "def handler():\n    pass\n",
      "p/y.py": "def handler():\n    pass\n",
      "p/main.py": [
        "def a():",
        "    from p.x import handler",
        "    handler()",
        "",
        "def b():",
        "    from p.y import handler",
        "    handler()",
        "",
        "def c():",
        "    from p import x as mod",
        "    mod.handler()",
        "",
        "def d():",
        "    from p import y as mod",
        "    mod.handler()",
        "",
      ].join("\n"),
    });
    const target = (fn: string) => edgesFrom(result.edges, sym("p/main.py", fn)).map((e) => e.dst);
    expect(target("a")).toEqual([sym("p/x.py", "handler")]);
    expect(target("b")).toEqual([sym("p/y.py", "handler")]);
    expect(target("c")).toEqual([sym("p/x.py", "handler")]);
    expect(target("d")).toEqual([sym("p/y.py", "handler")]);
  });
});

describe("receiver type inference and imports", () => {
  const classes =
    "class A1:\n    def validate(self):\n        pass\n\nclass B1:\n    def validate(self):\n        pass\n\n";

  it("is not cancelled by an unrelated import whose text contains the variable name", async () => {
    const { result } = await analyse({
      "ovl.py": `${classes}def three():\n    import os\n    s = A1()\n    s.validate()\n`,
    });
    const edges = edgesFrom(result.edges, sym("ovl.py", "three"));
    expect(edges.map((e) => e.dst)).toEqual([sym("ovl.py", "A1.validate")]);
    expect(edges[0]?.confidence).toBe("inferred");
  });

  it("is cancelled by an import that rebinds the variable", async () => {
    const { result } = await analyse({
      "ovl.py": `${classes}def f():\n    from other import s\n    s = A1()\n    s.validate()\n`,
    });
    const edges = edgesFrom(result.edges, sym("ovl.py", "f"));
    expect(edges.every((e) => e.confidence === "name-match")).toBe(true);
  });
});

describe("hostile input stays fast", () => {
  it("parses a setup.cfg line with a huge run of spaces in linear time", () => {
    const started = Date.now();
    parseIni(`[metadata]\nk${" ".repeat(150_000)}x\nname = demo\n`);
    parseIni(`[metadata]\nk${" ".repeat(1_900)}x\nname = demo\n`);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(parseIni("[metadata]\nname = demo\n").get("metadata")?.get("name")).toBe("demo");
  });

  it("infers self attribute types without rescanning the class per reference", async () => {
    const methods = Array.from(
      { length: 600 },
      (_, i) => `    def m${i}(self):\n        self.a.run()\n        self.a = Foo()\n`,
    );
    const started = Date.now();
    const ex = await extractPython(
      { path: "big.py", content: `class A:\n${methods.join("")}` },
      { timeoutMs: 20_000 },
    );
    expect(Date.now() - started).toBeLessThan(4000);
    expect(ex.references.find((r) => r.name === "run")?.receiverTypeHint).toBe("Foo");
  });

  it("infers many distinct local variables without rescanning the function per name", async () => {
    const lines = Array.from({ length: 800 }, (_, i) => `    v${i} = Foo()\n    v${i}.go()\n`);
    const started = Date.now();
    await extractPython({ path: "big2.py", content: `def f():\n${lines.join("")}` });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("attributes many annotations to their owners in near-linear time", async () => {
    const lines = Array.from({ length: 6000 }, (_, i) => `def f${i}(a: X):\n    pass\n`);
    const started = Date.now();
    const ex = await extractPython({ path: "ann.py", content: lines.join("") });
    expect(Date.now() - started).toBeLessThan(6000);
    expect(ex.references.find((r) => r.kind === "type")?.fromLocalId).toBe("f0");
  });
});
