import { describe, expect, it } from "vitest";
import { def, extract } from "./helpers.ts";

describe("method signatures as meta", () => {
  it("records parameter types and the return type without generics", async () => {
    const ex = await extract(`package a;
import java.util.List;
class A {
  List<String> names(int n, String[] rest, Map.Entry<K, V> e, long... more) { return null; }
  void none() {}
  int[] numbers() { return null; }
  <T> T pick() { return null; }
}`);
    const names = def(ex, "A.names").meta;
    expect(names?.["java.paramTypes"]).toEqual(["int", "String[]", "Map.Entry", "long[]"]);
    expect(names?.["java.returns"]).toBe("List");
    expect(def(ex, "A.none").meta?.["java.returns"]).toBe("void");
    expect(def(ex, "A.none").meta?.["java.paramTypes"]).toBeUndefined();
    expect(def(ex, "A.numbers").meta?.["java.returns"]).toBe("int[]");
    expect(def(ex, "A.pick").meta?.["java.returns"]).toBe("T");
  });
});

describe("java.callArgs", () => {
  it("types literals, variables, new, casts, class literals and constants", async () => {
    const ex = await extract(`package a;
class A {
  void m(String s, int n, long[] big) {
    f(s, n, big, "x", 1L, 2.0f, 'c', true, null, new Foo(), (Bar) s, Baz.class, Integer.MAX_VALUE);
  }
}`);
    const args = ex.meta?.["java.callArgs"] as Record<string, string[]>;
    expect(args["4:f#0"]).toEqual([
      "String",
      "int",
      "long[]",
      "String",
      "long",
      "float",
      "char",
      "boolean",
      "null",
      "Foo",
      "Bar",
      "Class",
      "int",
    ]);
  });

  it("types concatenations, ternaries, toString() and marks lambdas", async () => {
    const ex = await extract(`package a;
class A {
  void m(Object o) {
    g("a" + o, o == null ? "n" : "m", o.toString(), () -> 1, Mode.ON, o.other());
  }
}`);
    const args = ex.meta?.["java.callArgs"] as Record<string, string[]>;
    expect(args["4:g#0"]).toEqual(["String", "String", "String", "->", "~Mode", "?"]);
  });

  it("numbers repeated calls of one name on one line in document order", async () => {
    const ex = await extract(`package a;
class A {
  void m(int n, String s) {
    f(n); f(s);
  }
}`);
    const args = ex.meta?.["java.callArgs"] as Record<string, string[]>;
    expect(args["4:f#0"]).toEqual(["int"]);
    expect(args["4:f#1"]).toEqual(["String"]);
  });

  it("writes nothing when no argument type is known", async () => {
    const ex = await extract("package a;\nclass A { void m() { f(g()); } }");
    expect(ex.meta?.["java.callArgs"]).toBeUndefined();
  });
});

describe("receiver hints of call chains", () => {
  it("hints the type of the chain root, not of the whole receiver", async () => {
    const ex = await extract(`package a;
class A {
  private Repo repo;
  void m(Builder b) {
    b.name("x").build();
    this.repo.find().get();
    make().name("y").build();
  }
}`);
    const build = ex.references.filter((r) => r.name === "build");
    expect(build[0]?.receiverTypeHint).toBe("Builder");
    expect(build[1]?.receiverTypeHint).toBeUndefined(); // make() has no explicit root
    expect(ex.references.find((r) => r.name === "get")?.receiverTypeHint).toBe("Repo");
  });
});

describe("java.localTypes and java.anonSupers", () => {
  it("lists local classes and records", async () => {
    const ex = await extract(`package a;
class A {
  void m() {
    record P(int x) {}
    class Helper {}
  }
}`);
    expect(ex.meta?.["java.localTypes"]).toEqual(["Helper", "P"]);
  });

  it("records the types of the anonymous classes around an unqualified call", async () => {
    const ex = await extract(`package a;
class A {
  void m() {
    new Base() {
      void run() {
        bind(1);
        new Other<String>() { void x() { go(); } };
      }
    };
    top();
  }
}`);
    const supers = ex.meta?.["java.anonSupers"] as Record<string, string[]>;
    expect(supers["6:bind#0"]).toEqual(["Base"]);
    expect(supers["7:go#0"]).toEqual(["Other", "Base"]);
    expect(supers["10:top#0"]).toBeUndefined();
  });
});
