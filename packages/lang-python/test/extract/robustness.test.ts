import { FileExtractionSchema } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { extractPython } from "../../src/extract/index.ts";
import { def, extract, ref } from "./helpers.ts";

describe("python extraction robustness", () => {
  it("handles an empty file", async () => {
    const ex = await extract("");
    expect(ex).toMatchObject({ definitions: [], imports: [], references: [], parseErrors: 0 });
    expect(ex.language).toBe("python");
  });

  it("strips a BOM and handles CRLF", async () => {
    const ex = await extract("﻿import os\r\n\r\ndef f():\r\n    os.getcwd()\r\n");
    expect(ex.parseErrors).toBe(0);
    expect(def(ex, "f").span).toEqual({ startLine: 3, endLine: 4 });
    expect(ex.imports[0]?.specifier).toBe("os");
    expect(def(ex, "f").signature).toBe("f()");
  });

  it("counts syntax errors but still extracts what it can", async () => {
    const ex = await extract(
      "def ok():\n    pass\n\ndef broken(:\n    pass\n\ndef later():\n    pass\n",
    );
    expect(ex.parseErrors).toBeGreaterThan(0);
    expect(def(ex, "ok").kind).toBe("function");
  });

  it("survives Python 2 style code", async () => {
    const ex = await extract("f = lambda (a, b): a\nx = <> y\ndef f():\n    pass\n");
    expect(ex.parseErrors).toBeGreaterThan(0);
    expect(def(ex, "f").kind).toBe("function");
  });

  it("handles modern syntax: async, walrus, match, lambdas defaults, f-strings", async () => {
    const ex = await extract(`
async def main(items):
    if (n := len(items)) > 1:
        await go(n)
    match items:
        case [first, *rest]:
            handle(first)
        case {"k": v}:
            other(v)
    f = lambda x, y=helper(): x
    return f"{ items["a"] } {fmt(n)!r:>{width}}"
`);
    expect(ex.parseErrors).toBe(0);
    expect(def(ex, "main").meta?.isAsync).toBe(true);
    expect(ref(ex, "go").fromLocalId).toBe("main");
    expect(ref(ex, "handle").fromLocalId).toBe("main");
    expect(ref(ex, "helper").fromLocalId).toBe("main");
    expect(ref(ex, "fmt").fromLocalId).toBe("main");
  });

  it("handles unicode names and strings", async () => {
    const ex = await extract("def grüße(名前):\n    s = 'é😀'\n    return other(s)\n");
    expect(def(ex, "grüße").name).toBe("grüße");
    expect(ref(ex, "other").line).toBe(3);
  });

  it("handles a very long file", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) lines.push(`def f${i}(a: int) -> int:\n    return g${i}(a)\n`);
    const ex = await extract(lines.join("\n"));
    expect(ex.definitions).toHaveLength(5000);
    expect(ex.references.filter((r) => r.kind === "call")).toHaveLength(5000);
    expect(ex.parseErrors).toBe(0);
  });

  it("handles deeply nested expressions without a stack overflow", async () => {
    const depth = 3000;
    const ex = await extract(`x: ${"List[".repeat(depth)}Foo${"]".repeat(depth)} = None\n`);
    expect(ex.definitions).toEqual([]);
  });

  it("is deterministic and schema-valid", async () => {
    const src = "import os\nclass A(B):\n    def m(self, x: C):\n        self.go(os.sep)\n";
    const a = await extract(src);
    const b = await extract(src);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(FileExtractionSchema.safeParse(a).success).toBe(true);
  });

  it("reports a timeout as a parse error instead of throwing", async () => {
    const big = "x = [1,2,3]\n".repeat(200_000);
    const ex = await extractPython({ path: "big.py", content: big }, { timeoutMs: 1 });
    expect(ex.parseErrors).toBeGreaterThanOrEqual(0);
    expect(ex.file).toBe("big.py");
  });
});
