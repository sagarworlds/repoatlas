import { describe, expect, it } from "vitest";
import { def, extract } from "./helpers.ts";

describe("java definitions", () => {
  it("emits types, nested types, methods and constructors with ids", async () => {
    const ex = await extract(`package com.acme;

public class User {
  private int age;
  public User(String name) {}
  public void save() {}
  static class Builder {
    Builder build() { return this; }
  }
  interface Visitor { void visit(User u); }
  enum Role { ADMIN, GUEST; boolean isAdmin() { return this == ADMIN; } }
  record Point(int x, int y) {
    Point { }
    double dist() { return 0; }
  }
  @interface Marker { String value(); }
}
interface Repo<T> { T find(long id); }
`);
    expect(ex.definitions.map((d) => [d.localId, d.kind, d.parentLocalId])).toEqual([
      ["User", "class", undefined],
      ["User.User", "method", "User"],
      ["User.save", "method", "User"],
      ["User.Builder", "class", "User"],
      ["User.Builder.build", "method", "User.Builder"],
      ["User.Visitor", "interface", "User"],
      ["User.Visitor.visit", "method", "User.Visitor"],
      ["User.Role", "class", "User"],
      ["User.Role.isAdmin", "method", "User.Role"],
      ["User.Point", "class", "User"],
      ["User.Point.Point", "method", "User.Point"],
      ["User.Point.dist", "method", "User.Point"],
      ["User.Marker", "class", "User"],
      ["Repo", "interface", undefined],
      ["Repo.find", "method", "Repo"],
    ]);
    expect(ex.parseErrors).toBe(0);
    expect(ex.language).toBe("java");
    expect(ex.meta?.["java.package"]).toBe("com.acme");
  });

  it("records java.kind for enum, record and annotation types", async () => {
    const ex = await extract("enum E { A }\nrecord R(int a) {}\n@interface M {}\nclass C {}\n");
    expect(def(ex, "E").meta?.["java.kind"]).toBe("enum");
    expect(def(ex, "R").meta?.["java.kind"]).toBe("record");
    expect(def(ex, "M").meta?.["java.kind"]).toBe("annotation");
    expect(def(ex, "C").meta?.["java.kind"]).toBeUndefined();
  });

  it("disambiguates overloads with the start line", async () => {
    const ex = await extract(`class A {
  void f() {}
  void f(int x) {}
  void f(String s) {}
}
`);
    expect(ex.definitions.map((d) => d.localId)).toEqual(["A", "A.f", "A.f@3", "A.f@4"]);
    expect(def(ex, "A.f").meta?.["java.params"]).toBe(0);
    expect(def(ex, "A.f@3").meta?.["java.params"]).toBe(1);
  });

  it("builds one-line signatures", async () => {
    const ex = await extract(`public class User<T> extends Base<T> implements A, B {
  public User save(
      boolean force, // a comment
      String... names) throws IOException {
    return this;
  }
  protected <U extends Number> List<U> all() { return null; }
  public User(String name) {}
}
interface Repo<T> extends Base, Other<T> { T find(long id); }
`);
    expect(def(ex, "User").signature).toBe("class User<T> extends Base<T> implements A, B");
    expect(def(ex, "User.save").signature).toBe(
      "public User save(boolean force, String... names) throws IOException",
    );
    expect(def(ex, "User.all").signature).toBe("protected <U extends Number> List<U> all()");
    expect(def(ex, "User.User").signature).toBe("public User(String name)");
    expect(def(ex, "Repo").signature).toBe("interface Repo<T> extends Base, Other<T>");
    expect(def(ex, "Repo.find").signature).toBe("T find(long id)");
  });

  it("fills visibility, static, abstract, annotations, params and varargs", async () => {
    const ex = await extract(`public abstract class Svc {
  @Override @org.junit.Foo(1) public static void a(int x, String... rest) {}
  private void b() {}
  protected abstract void c();
  void d() {}
  Svc() {}
}
interface I { void m(); default void n() {} static void s() {} }
`);
    const a = def(ex, "Svc.a").meta;
    expect(a?.visibility).toBe("public");
    expect(a?.isStatic).toBe(true);
    expect(a?.isExported).toBe(true);
    expect(a?.["java.params"]).toBe(2);
    expect(a?.["java.varargs"]).toBe(true);
    expect(a?.["java.annotations"]).toEqual(["Override", "org.junit.Foo"]);
    expect(def(ex, "Svc.b").meta?.visibility).toBe("private");
    expect(def(ex, "Svc.c").meta?.visibility).toBe("protected");
    expect(def(ex, "Svc.c").meta?.["java.abstract"]).toBe(true);
    expect(def(ex, "Svc.d").meta?.visibility).toBe("internal");
    expect(def(ex, "Svc.d").meta?.isExported).toBe(false);
    expect(def(ex, "Svc").meta?.["java.abstract"]).toBe(true);
    const ctor = def(ex, "Svc.Svc").meta;
    expect(ctor?.isConstructor).toBe(true);
    expect(ctor?.["java.params"]).toBe(0);
    expect(def(ex, "I.m").meta?.visibility).toBe("public");
    expect(def(ex, "I.m").meta?.["java.abstract"]).toBe(true);
    expect(def(ex, "I.n").meta?.["java.abstract"]).toBeUndefined();
    expect(def(ex, "I.s").meta?.isStatic).toBe(true);
  });

  it("gives a record's compact constructor the component count", async () => {
    const ex = await extract("record P(int x, int y) { P { } }\n");
    const ctor = def(ex, "P.P");
    expect(ctor.meta?.isConstructor).toBe(true);
    expect(ctor.meta?.["java.params"]).toBe(2);
  });

  it("marks tests by path, class name and annotation", async () => {
    const inTestDir = await extract(
      "class Helper { void h() {} }\n",
      "src/test/java/a/Helper.java",
    );
    expect(def(inTestDir, "Helper").meta?.isTest).toBe(true);
    expect(inTestDir.meta?.isTest).toBe(true);

    const byName = await extract(
      "class FooTest { void a() {} }\nclass Plain { void b() {} }\n",
      "src/main/java/FooTest.java",
    );
    expect(def(byName, "FooTest.a").meta?.isTest).toBe(true);

    const byAnnotation = await extract(
      "class Plain { @Test void a() {} @BeforeEach void setUp() {} void helper() {} }\n",
      "src/main/java/Plain.java",
    );
    expect(def(byAnnotation, "Plain.a").meta?.isTest).toBe(true);
    expect(def(byAnnotation, "Plain.setUp").meta?.isTest).toBe(true);
    expect(def(byAnnotation, "Plain.helper").meta?.isTest).toBeUndefined();
    expect(def(byAnnotation, "Plain").meta?.isTest).toBeUndefined();
    expect(byAnnotation.meta?.isTest).toBeUndefined();
  });

  it("does not create nodes for lambdas, anonymous classes, local classes or enum constant bodies", async () => {
    const ex = await extract(`class A {
  void run() {
    Runnable r = () -> helper();
    Object o = new Object() { void inner() { helper(); } };
    class Local { void m() { helper(); } }
  }
  enum E { X { void y() {} } }
}
`);
    expect(ex.definitions.map((d) => d.localId)).toEqual(["A", "A.run", "A.E"]);
    for (const r of ex.references.filter((r) => r.name === "helper")) {
      expect(r.fromLocalId).toBe("A.run");
    }
    expect(ex.references.filter((r) => r.name === "helper")).toHaveLength(3);
  });

  it("keeps file-level members only inside named types", async () => {
    const ex = await extract("package a;\n");
    expect(ex.definitions).toEqual([]);
    expect(ex.meta?.["java.package"]).toBe("a");
  });
});
