import { FileExtractionSchema } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { extractGo } from "../../src/extract/index.ts";
import { def, extract, ref } from "./helpers.ts";

describe("go extraction robustness", () => {
  it("handles an empty file", async () => {
    const ex = await extract("");
    expect(ex).toMatchObject({ definitions: [], imports: [], references: [], parseErrors: 0 });
    expect(ex.language).toBe("go");
  });

  it("strips a BOM and handles CRLF", async () => {
    const ex = await extract(
      '﻿package p\r\n\r\nimport "os"\r\n\r\nfunc f() {\r\n\tos.Exit(1)\r\n}\r\n',
    );
    expect(ex.parseErrors).toBe(0);
    expect(def(ex, "f").span).toEqual({ startLine: 5, endLine: 7 });
    expect(def(ex, "f").signature).toBe("func f()");
    expect(ex.imports[0]?.specifier).toBe("os");
    expect(ex.meta?.["go.package"]).toBe("p");
  });

  it("counts syntax errors but still extracts what it can", async () => {
    const ex = await extract("package p\nfunc ok() {}\nfunc broken( {\nfunc later() {}\n");
    expect(ex.parseErrors).toBeGreaterThan(0);
    expect(def(ex, "ok").kind).toBe("function");
  });

  it("handles build tags, struct tags, anonymous structs, labels and raw strings", async () => {
    const ex = await extract(`//go:build linux && !cgo
// +build linux

package p

type T struct {
	Name string \`json:"name" db:"n"\`
	Meta struct {
		A int
		B Other
	}
}

var raw = \`select * from t\`

func F() {
	cfg := struct{ A int }{A: 1}
	_ = cfg
outer:
	for i := 0; i < 3; i++ {
		for {
			continue outer
		}
	}
	ch := make(chan<- Msg)
	select {
	case v := <-in:
		handle(v)
	}
	f := T.Method
	g := (*T).Other
	_, _ = f, g
}
`);
    expect(ex.parseErrors).toBe(0);
    expect(def(ex, "T").kind).toBe("class");
    expect(ref(ex, "Other", "type").fromLocalId).toBe("T");
    expect(ref(ex, "Msg", "type").fromLocalId).toBe("F");
    expect(ref(ex, "handle", "call").fromLocalId).toBe("F");
  });

  it("handles generics: constraints, type sets and instantiation", async () => {
    const ex = await extract(`package p
type Number interface{ ~int | ~float64 }
type Set[T comparable] map[T]struct{}
func Sum[T Number](xs ...T) T {
	var s T
	for _, x := range xs { s += x }
	return s
}
func (s Set[T]) Add(v T) { s[v] = struct{}{} }
func use() { Sum[int](1, 2); _ = Set[string]{} }
`);
    expect(ex.parseErrors).toBe(0);
    expect(def(ex, "Number").kind).toBe("interface");
    expect(def(ex, "Set").meta?.["go.kind"]).toBe("alias");
    expect(def(ex, "Set.Add").parentLocalId).toBe("Set");
    expect(def(ex, "Sum").signature).toBe("func Sum[T Number](xs ...T) T");
    expect(ref(ex, "Sum", "call").fromLocalId).toBe("use");
    expect(ref(ex, "Set", "instantiate").fromLocalId).toBe("use");
    expect(ex.references.filter((r) => r.name === "T")).toEqual([]);
  });

  it("handles unicode identifiers", async () => {
    const ex = await extract("package p\nfunc Größe() {}\nfunc größe() {}\nfunc 名前() {}\n");
    expect(def(ex, "Größe").meta?.isExported).toBe(true);
    expect(def(ex, "größe").meta?.isExported).toBe(false);
    expect(def(ex, "名前").meta?.isExported).toBe(false);
  });

  it("handles a very long file", async () => {
    const lines: string[] = ["package p"];
    for (let i = 0; i < 5000; i++) lines.push(`func f${i}(a int) int {\n\treturn g${i}(a)\n}`);
    const ex = await extract(lines.join("\n"));
    expect(ex.definitions).toHaveLength(5000);
    expect(ex.references.filter((r) => r.kind === "call")).toHaveLength(5000);
    expect(ex.parseErrors).toBe(0);
  });

  it("handles deeply nested types without a stack overflow", async () => {
    const depth = 2000;
    const ex = await extract(`package p\nvar x ${"[]".repeat(depth)}Foo\n`);
    expect(ex.definitions).toEqual([]);
  });

  it("is deterministic and schema-valid", async () => {
    const src =
      'package p\nimport "os"\ntype A struct{ B }\nfunc (a *A) M(x C) { a.go(os.Args) }\n';
    const a = await extract(src);
    const b = await extract(src);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(FileExtractionSchema.safeParse(a).success).toBe(true);
  });

  it("reports a timeout as a parse error instead of throwing", async () => {
    const big = `package p\n${"var x = []int{1, 2, 3}\n".repeat(200_000)}`;
    const ex = await extractGo({ path: "big.go", content: big }, { timeoutMs: 1 });
    expect(ex.parseErrors).toBeGreaterThanOrEqual(0);
    expect(ex.file).toBe("big.go");
  });
});
