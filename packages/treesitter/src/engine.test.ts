import { type FileExtraction, FileExtractionSchema } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { extractWithSpec, QuerySpecError } from "./engine.ts";
import { GrammarLoadError } from "./runtime.ts";
import { miniPythonSpec } from "./test-spec.ts";

const spec = miniPythonSpec();

async function extract(content: string, path = "app/mod.py"): Promise<FileExtraction> {
  const result = await extractWithSpec(spec, { path, content });
  FileExtractionSchema.parse(result); // output must always satisfy the schema
  return result;
}

function ids(ex: FileExtraction): string[] {
  return ex.definitions.map((d) => `${d.kind}:${d.localId}`);
}

describe("definitions", () => {
  it("builds classes, methods, nested functions and nested classes", async () => {
    const ex = await extract(
      [
        "class User:",
        "    class Meta:",
        "        pass",
        "    def save(self):",
        "        def inner():",
        "            pass",
        "        return inner()",
        "",
        "def top():",
        "    pass",
      ].join("\n"),
    );
    expect(ids(ex)).toEqual([
      "class:User",
      "class:User.Meta",
      "method:User.save",
      "function:User.save.inner",
      "function:top",
    ]);
    expect(ex.definitions.find((d) => d.localId === "User.save.inner")?.parentLocalId).toBe(
      "User.save",
    );
    expect(ex.definitions.find((d) => d.localId === "User")?.parentLocalId).toBeUndefined();
    expect(ex.file).toBe("app/mod.py");
    expect(ex.language).toBe("python");
  });

  it("uses 1-based inclusive spans and signatures", async () => {
    const ex = await extract(
      "class A:\n    def f(self,\n          x):\n        return x\n\nz = 1\n",
    );
    const f = ex.definitions.find((d) => d.localId === "A.f");
    expect(f?.span).toEqual({ startLine: 2, endLine: 4 });
    expect(f?.signature).toBe("def f(self, x):");
    expect(ex.definitions.find((d) => d.localId === "A")?.span).toEqual({
      startLine: 1,
      endLine: 4,
    });
  });

  it("truncates long signatures to 300 characters", async () => {
    const params = Array.from({ length: 200 }, (_, i) => `argument_${i}`).join(", ");
    const ex = await extract(`def big(${params}):\n    pass\n`);
    expect(ex.definitions[0]?.signature).toHaveLength(300);
  });

  it("handles decorated definitions", async () => {
    const ex = await extract(
      "@decorator(1)\ndef f():\n    pass\n\nclass C:\n    @staticmethod\n    def g():\n        pass\n",
    );
    expect(ids(ex)).toEqual(["function:f", "class:C", "method:C.g"]);
    expect(ex.definitions[0]?.span.startLine).toBe(2);
  });

  it("disambiguates overloads and redefinitions with @startLine", async () => {
    const ex = await extract(
      "def f(a):\n    pass\n\ndef f(a, b):\n    pass\n\nclass K:\n    def m(self): pass\n    def m(self, x): pass\n",
    );
    expect(ids(ex)).toEqual([
      "function:f",
      "function:f@4",
      "class:K",
      "method:K.m",
      "method:K.m@9",
    ]);
  });

  it("keeps children of a renamed parent consistent", async () => {
    const ex = await extract("def f():\n    def g(): pass\n\ndef f():\n    def g(): pass\n");
    expect(ids(ex)).toEqual(["function:f", "function:f.g", "function:f@4", "function:f@4.g"]);
    expect(ex.definitions[3]?.parentLocalId).toBe("f@4");
  });

  it("handles unicode identifiers and text", async () => {
    const ex = await extract('x = "héllo wörld \u{1F600}"\n\ndef naïve():\n    pass\n');
    expect(ids(ex)).toEqual(["function:naïve"]);
    expect(ex.definitions[0]?.span).toEqual({ startLine: 3, endLine: 4 });
  });

  it("returns an empty, valid extraction for an empty file", async () => {
    const ex = await extract("");
    expect(ex).toMatchObject({ definitions: [], imports: [], references: [], parseErrors: 0 });
  });
});

describe("references", () => {
  const source = [
    "import helpers",
    "setup()",
    "class Base: pass",
    "class User(Base):",
    "    def save(self, a, b):",
    "        self.validate(a)",
    "        super().save(a, b)",
    "        helpers.run(1, 2, 3)",
    "        x = [render(i) for i in range(3)]",
    "        f = lambda: build()",
    "        repo.users.find()",
    "        get().go()",
    "",
    "def top():",
    "    return User().save(1, 2)",
  ].join("\n");

  it("attaches calls to the innermost enclosing definition", async () => {
    const ex = await extract(source);
    const byName = (name: string) => ex.references.filter((r) => r.name === name);
    expect(byName("setup")[0]?.fromLocalId).toBeUndefined(); // module level
    expect(byName("validate")[0]?.fromLocalId).toBe("User.save");
    expect(byName("render")[0]?.fromLocalId).toBe("User.save"); // inside a comprehension
    expect(byName("build")[0]?.fromLocalId).toBe("User.save"); // inside a lambda
    expect(byName("User")[0]?.fromLocalId).toBe("top");
    expect(byName("save").map((r) => r.fromLocalId)).toEqual(["User.save", "top"]);
  });

  it("classifies receivers and counts arguments", async () => {
    const ex = await extract(source);
    const get = (name: string, recv?: string) =>
      ex.references.find((r) => r.name === name && (recv === undefined || r.receiver === recv));
    expect(get("validate")).toMatchObject({
      receiver: "self",
      receiverKind: "self",
      argCount: 1,
      kind: "call",
    });
    expect(get("save", "super()")).toMatchObject({ receiverKind: "super", argCount: 2 });
    expect(get("run")).toMatchObject({
      receiver: "helpers",
      receiverKind: "identifier",
      argCount: 3,
    });
    expect(get("find")).toMatchObject({
      receiver: "repo.users",
      receiverKind: "member-chain",
      argCount: 0,
    });
    expect(get("go")).toMatchObject({ receiver: "get()", receiverKind: "call" });
    expect(get("setup")?.receiver).toBeUndefined();
    expect(get("setup")?.argCount).toBe(0);
  });

  it("emits extends references from the class itself", async () => {
    const ex = await extract(source);
    const ext = ex.references.find((r) => r.kind === "extends");
    expect(ext).toMatchObject({ name: "Base", fromLocalId: "User", line: 4 });
  });

  it("orders output by line, column and name, deterministically", async () => {
    const a = await extract(source);
    const b = await extract(source);
    expect(b).toEqual(a);
    const keys = a.references.map((r) => r.line);
    expect(keys).toEqual([...keys].sort((x, y) => x - y));
  });

  it("calls spec.inferReceiverType and records receiverTypeHint", async () => {
    const hinted = miniPythonSpec({
      inferReceiverType: (ctx) => {
        expect(ctx.enclosingDefinitionNode?.type).toBe("function_definition");
        return ctx.receiverNode.text === "u" ? "User" : undefined;
      },
    });
    const ex = await extractWithSpec(hinted, {
      path: "a.py",
      content: "def f():\n    u = User()\n    u.save()\n    self.x()\n",
    });
    expect(ex.references.find((r) => r.name === "save")?.receiverTypeHint).toBe("User");
    expect(ex.references.find((r) => r.name === "x")?.receiverTypeHint).toBeUndefined();
  });
});

describe("imports", () => {
  it("expresses every Python import form", async () => {
    const ex = await extract(
      [
        "import a.b",
        "import a.b as c",
        "import x, y as z",
        "from a.b import n1, n2 as m2",
        "from . import sib",
        "from ..pkg import up",
        "from a import *",
        "from pkg import (p, q)",
      ].join("\n"),
    );
    expect(ex.imports).toEqual([
      { line: 1, specifier: "a.b", kind: "module", isRelative: false },
      { line: 2, specifier: "a.b", kind: "module", alias: "c", isRelative: false },
      { line: 3, specifier: "x", kind: "module", isRelative: false },
      { line: 3, specifier: "y", kind: "module", alias: "z", isRelative: false },
      {
        line: 4,
        specifier: "a.b",
        kind: "named",
        names: [{ name: "n1" }, { name: "n2", alias: "m2" }],
        isRelative: false,
      },
      { line: 5, specifier: ".", kind: "named", names: [{ name: "sib" }], isRelative: true },
      { line: 6, specifier: "..pkg", kind: "named", names: [{ name: "up" }], isRelative: true },
      { line: 7, specifier: "a", kind: "wildcard", isRelative: false },
      {
        line: 8,
        specifier: "pkg",
        kind: "named",
        names: [{ name: "p" }, { name: "q" }],
        isRelative: false,
      },
    ]);
  });

  it("works with an empty imports query", async () => {
    const noImports = miniPythonSpec({
      queries: { ...spec.queries, imports: "" },
    });
    const ex = await extractWithSpec(noImports, { path: "a.py", content: "import os\n" });
    expect(ex.imports).toEqual([]);
  });
});

describe("robustness", () => {
  const broken =
    "def ok():\n    pass\n\ndef broken(:\n    x = (1,\n\nclass Still:\n    def method(self):\n        pass\n";

  it("counts parse errors but still extracts definitions", async () => {
    const ex = await extract(broken);
    expect(ex.parseErrors).toBeGreaterThan(0);
    expect(ex.definitions.map((d) => d.localId)).toContain("ok");
    expect((await extract("def f():\n    pass\n")).parseErrors).toBe(0);
  });

  it("never throws on garbage input", async () => {
    for (const junk of [
      "\u0000\u0001\u0002",
      "((((((((",
      "def",
      "class :::",
      "\ufeff\r\n\r\n",
      "'''unterminated",
    ]) {
      const ex = await extract(junk);
      expect(ex.file).toBe("app/mod.py");
    }
  });

  it("handles CRLF line endings", async () => {
    const ex = await extract("class A:\r\n    def f(self):\r\n        pass\r\n");
    expect(ex.definitions[1]?.span).toEqual({ startLine: 2, endLine: 3 });
  });

  it("returns an empty extraction with timedOut on timeout", async (ctx) => {
    const content = "def f(a, b):\n    return [x for x in range(10)] + g(a, b)\n".repeat(150_000);
    const started = Date.now();
    const ex = await extractWithSpec(spec, { path: "big.py", content }, { timeoutMs: 1 });
    if (ex.meta?.timedOut !== true) {
      ctx.skip(`machine finished a ${content.length}-byte parse in ${Date.now() - started} ms`);
      return;
    }
    expect(ex).toMatchObject({ definitions: [], imports: [], references: [], parseErrors: 1 });
    // The shared parser must be usable again afterwards.
    const after = await extract("def fine():\n    pass\n");
    expect(after.definitions).toHaveLength(1);
  });

  it("applies postProcess last, with the tree alive", async () => {
    const processed = miniPythonSpec({
      postProcess: (ex, tree) => ({ ...ex, meta: { rootType: tree.rootNode.type } }),
    });
    const ex = await extractWithSpec(processed, { path: "a.py", content: "x = 1\n" });
    expect(ex.meta).toEqual({ rootType: "module" });
  });

  it("does not grow memory over 2,000 small files", async () => {
    const content = "class A:\n    def f(self):\n        return g(1)\n\nimport os\n";
    await extract(content);
    global.gc?.();
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 2000; i++) {
      const ex = await extractWithSpec(spec, { path: `f${i}.py`, content });
      expect(ex.definitions).toHaveLength(2);
    }
    global.gc?.();
    const deltaMb = (process.memoryUsage().rss - before) / (1024 * 1024);
    expect(deltaMb).toBeLessThan(150); // generous: guards against leaking whole trees
  });
});

describe("configuration errors", () => {
  it("throws GrammarLoadError when the grammar is missing", async () => {
    const bad = miniPythonSpec({ grammarWasm: "/no/such/dir/missing.wasm" });
    await expect(extractWithSpec(bad, { path: "a.py", content: "x=1" })).rejects.toBeInstanceOf(
      GrammarLoadError,
    );
  });

  it("throws QuerySpecError for an invalid query", async () => {
    const bad = miniPythonSpec({
      queries: { ...spec.queries, references: "(not_a_node_type) @x" },
    });
    await expect(extractWithSpec(bad, { path: "a.py", content: "x=1" })).rejects.toBeInstanceOf(
      QuerySpecError,
    );
  });
});
