import { describe, expect, it } from "vitest";
import { extractJava } from "../../src/extract/index.ts";
import { def, extract } from "./helpers.ts";

describe("java robustness", () => {
  it("handles an empty file and whitespace only", async () => {
    for (const content of ["", "   \n\n"]) {
      const ex = await extract(content);
      expect(ex).toMatchObject({ definitions: [], imports: [], references: [], parseErrors: 0 });
    }
  });

  it("handles package-info.java, module-info.java and annotation-only files", async () => {
    const pkg = await extract("@Deprecated\npackage com.acme;\n", "com/acme/package-info.java");
    expect(pkg.definitions).toEqual([]);
    expect(pkg.meta?.["java.package"]).toBe("com.acme");
    const mod = await extract(
      "module com.acme { requires java.base; exports com.acme.api; }\n",
      "module-info.java",
    );
    expect(mod.definitions).toEqual([]);
    expect(mod.parseErrors).toBe(0);
    const ann = await extract("@interface Only {}\n");
    expect(def(ann, "Only").meta?.["java.kind"]).toBe("annotation");
  });

  it("omits java.package for the default package", async () => {
    const ex = await extract("class A {}\n");
    expect(ex.meta?.["java.package"]).toBeUndefined();
  });

  it("removes a BOM and tolerates CRLF", async () => {
    const ex = await extract(
      "﻿package a;\r\nimport b.C;\r\nclass A {\r\n  void f() { g(); }\r\n}\r\n",
    );
    expect(ex.parseErrors).toBe(0);
    expect(ex.meta?.["java.package"]).toBe("a");
    expect(def(ex, "A.f").span).toEqual({ startLine: 4, endLine: 4 });
    expect(ex.imports[0]?.line).toBe(2);
  });

  it("handles modern syntax: text blocks, switch expressions, sealed types, records, nested generics", async () => {
    const ex = await extract(`package a;
public sealed interface Shape permits Circle, Square {}
record Circle(double r) implements Shape {
  Circle { if (r < 0) throw new IllegalArgumentException("neg"); }
}
final class Square implements Shape {}
class Main {
  static final String T = """
      hello "world"
      """;
  int f(Shape s) {
    return switch (s) {
      case Circle c -> area(c);
      case Square q -> 4;
    };
  }
  Map<String, Map<Integer, List<Optional<Item>>>> deep() { return null; }
}
`);
    expect(ex.parseErrors).toBe(0);
    expect(ex.definitions.map((d) => d.localId)).toContain("Circle.Circle");
    expect(ex.references.some((r) => r.name === "area" && r.kind === "call")).toBe(true);
    expect(ex.references.some((r) => r.name === "Item" && r.kind === "type")).toBe(true);
    expect(
      ex.references.filter((r) => r.name === "Circle" && r.kind === "type").length,
    ).toBeGreaterThan(0);
  });

  it("handles unicode identifiers", async () => {
    const ex = await extract("class Größe { void größer() { prüfe(); } }\n");
    expect(def(ex, "Größe.größer").kind).toBe("method");
    expect(ex.references.some((r) => r.name === "prüfe")).toBe(true);
  });

  it("counts syntax errors and never throws", async () => {
    const ex = await extract("class A { void f( { int x = ; }\nclass B { void ok() {} }\n");
    expect(ex.parseErrors).toBeGreaterThan(0);
    expect(ex.definitions.length).toBeGreaterThan(0);
    const garbage = await extract("}}}{{{ @@@ ;;; class\n");
    expect(garbage.parseErrors).toBeGreaterThan(0);
  });

  it("copes with a huge file and deeply nested expressions", async () => {
    const methods = Array.from({ length: 3000 }, (_, i) => `  void m${i}() { call${i}(); }`).join(
      "\n",
    );
    const big = await extract(`class Big {\n${methods}\n}\n`);
    expect(big.definitions).toHaveLength(3001);
    expect(big.references.filter((r) => r.kind === "call")).toHaveLength(3000);

    const chain = Array.from({ length: 2000 }, (_, i) => `"s${i}"`).join(" + ");
    const deep = await extract(`class D { String s = ${chain}; void f(Foo x) { x.go(); } }\n`);
    expect(deep.definitions.map((d) => d.localId)).toEqual(["D", "D.f"]);
  });

  it("returns an empty extraction with parseErrors 1 when the time budget is zero", async () => {
    const methods = Array.from({ length: 500 }, (_, i) => `void m${i}() {}`).join("\n");
    const ex = await extractJava(
      { path: "A.java", content: `class A {\n${methods}\n}\n` },
      { timeoutMs: -1 },
    );
    expect(ex.parseErrors).toBe(1);
    expect(ex.definitions).toEqual([]);
    expect(ex.meta).toMatchObject({ timedOut: true });
  });

  it("produces output that sorts references by line", async () => {
    const ex = await extract("class A {\n  Foo f;\n  void g() { h(); }\n  Bar b;\n}\n");
    const lines = ex.references.map((r) => r.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});
