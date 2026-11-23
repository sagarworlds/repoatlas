import { describe, expect, it } from "vitest";
import { extract, ref, refs } from "./helpers.ts";

describe("java call references", () => {
  it("handles plain, this, super, receiver and static calls", async () => {
    const ex = await extract(`class A extends B {
  void run(Repo repo) {
    foo(1, 2);
    this.bar();
    super.baz();
    repo.save(x);
    Util.helper();
    a.b.Util.deep();
    make().chain();
  }
}
`);
    const foo = ref(ex, "foo", "call");
    expect(foo).toMatchObject({ line: 3, argCount: 2, fromLocalId: "A.run" });
    expect(foo.receiver).toBeUndefined();
    expect(ref(ex, "bar")).toMatchObject({ receiver: "this", receiverKind: "self", argCount: 0 });
    expect(ref(ex, "baz")).toMatchObject({ receiver: "super", receiverKind: "super" });
    expect(ref(ex, "save")).toMatchObject({
      receiver: "repo",
      receiverKind: "identifier",
      receiverTypeHint: "Repo",
    });
    expect(ref(ex, "helper")).toMatchObject({ receiver: "Util", receiverKind: "identifier" });
    expect(ref(ex, "deep")).toMatchObject({ receiver: "a.b.Util", receiverKind: "member-chain" });
    expect(ref(ex, "chain")).toMatchObject({ receiverKind: "call" });
    expect(refs(ex, "foo", "call")).toHaveLength(1);
  });

  it("emits this(...) and super(...) from the constructor", async () => {
    const ex = await extract(`class A extends B {
  A() { this(1); }
  A(int x) { super(x, 2); }
}
`);
    const self = ref(ex, "this", "call");
    expect(self).toMatchObject({ receiverKind: "self", argCount: 1, fromLocalId: "A.A" });
    const sup = ref(ex, "super", "call");
    expect(sup).toMatchObject({ receiverKind: "super", argCount: 2, fromLocalId: "A.A@3" });
  });

  it("emits method references as calls without argCount", async () => {
    const ex = await extract(`class A {
  void f() {
    Runnable r = Foo::bar;
    Runnable s = this::baz;
    java.util.function.Supplier<X> t = X::new;
  }
}
`);
    const bar = ref(ex, "bar", "call");
    expect(bar).toMatchObject({ receiver: "Foo", receiverKind: "identifier" });
    expect(bar.argCount).toBeUndefined();
    expect(ref(ex, "baz", "call")).toMatchObject({ receiver: "this", receiverKind: "self" });
    expect(ref(ex, "X", "instantiate").argCount).toBeUndefined();
  });

  it("attributes calls in lambdas and anonymous classes to the enclosing method", async () => {
    const ex = await extract(`class A {
  void f() {
    list.forEach(x -> process(x));
    new Thread(new Runnable() { public void run() { work(); } }).start();
  }
  int field = compute();
}
`);
    expect(ref(ex, "process").fromLocalId).toBe("A.f");
    expect(ref(ex, "work").fromLocalId).toBe("A.f");
    expect(ref(ex, "compute").fromLocalId).toBe("A");
  });
});

describe("java instantiation and heritage", () => {
  it("emits instantiate references with argCount and qualified names", async () => {
    const ex = await extract(`class A {
  void f() {
    new Foo(1);
    new Bar<>(a, b);
    new a.b.Baz();
    new Outer.Inner(1, 2, 3);
    Object o = new Object();
  }
}
`);
    expect(ref(ex, "Foo", "instantiate")).toMatchObject({ argCount: 1, fromLocalId: "A.f" });
    expect(ref(ex, "Bar", "instantiate")).toMatchObject({ argCount: 2 });
    expect(ref(ex, "Baz", "instantiate")).toMatchObject({ receiver: "a.b", argCount: 0 });
    expect(ref(ex, "Inner", "instantiate")).toMatchObject({ receiver: "Outer", argCount: 3 });
    expect(refs(ex, "Foo", "type")).toHaveLength(0);
  });

  it("emits extends and implements, one reference per type, generics stripped", async () => {
    const ex = await extract(`class User extends Base<T> implements A, b.c.B<X>, C {}
interface I extends J, K<V> {}
enum E implements A {}
record R(int a) implements A {}
class Inner extends Outer.Base {}
`);
    expect(ref(ex, "Base", "extends")).toMatchObject({ line: 1, fromLocalId: "User" });
    expect(refs(ex, "A", "implements").map((r) => r.fromLocalId)).toEqual(["User", "E", "R"]);
    expect(ref(ex, "B", "implements")).toMatchObject({ receiver: "b.c" });
    expect(ref(ex, "C", "implements")).toBeDefined();
    expect(refs(ex, "J", "extends")).toHaveLength(1);
    expect(ref(ex, "K", "extends").fromLocalId).toBe("I");
    expect(ref(ex, "Base", "extends")).toBeDefined();
    expect(refs(ex, "Base", "extends")).toHaveLength(2);
    expect(refs(ex, "Base", "extends").find((r) => r.receiver === "Outer")).toBeDefined();
    // type arguments of heritage types are type references
    expect(ref(ex, "T", "type")).toBeDefined();
    expect(ref(ex, "X", "type")).toBeDefined();
    expect(refs(ex, "Base", "type")).toHaveLength(0);
  });
});

describe("java type and annotation references", () => {
  it("emits types from fields, parameters, returns, locals, generics, throws, casts and catch", async () => {
    const ex = await extract(`class A {
  private Repo repo;
  Map<Key, List<Value>> map;
  Item[] items;
  Entity get(Request req) throws AppException {
    Local l = (Cast) req;
    try { run(); } catch (IoFail | NetFail e) { }
    if (req instanceof Special s) { }
    return Thing.class == null ? null : null;
  }
}
`);
    for (const name of [
      "Repo",
      "Map",
      "Key",
      "List",
      "Value",
      "Item",
      "Entity",
      "Request",
      "AppException",
      "Local",
      "Cast",
      "IoFail",
      "NetFail",
      "Special",
      "Thing",
    ]) {
      expect(refs(ex, name, "type").length, name).toBeGreaterThan(0);
    }
    expect(ref(ex, "Repo", "type").fromLocalId).toBe("A");
    expect(ref(ex, "Entity", "type").fromLocalId).toBe("A.get");
    expect(ref(ex, "Request", "type").fromLocalId).toBe("A.get");
    expect(ref(ex, "Cast", "type").fromLocalId).toBe("A.get");
  });

  it("skips primitives, var, common java.lang names and type parameters", async () => {
    const ex = await extract(`class A<T extends Comparable<T>> {
  <U> U pick(T t, U u, String s, Object o, Integer i, int n, var v) {
    var w = 1;
    List<T> l = null;
    return u;
  }
}
`);
    const names = ex.references.filter((r) => r.kind === "type").map((r) => r.name);
    expect(names).toEqual(["Comparable", "List"]);
  });

  it("splits qualified types into receiver and name", async () => {
    const ex = await extract("class A { java.util.List<Map.Entry<K, V>> f; Outer.Inner g; }\n");
    expect(ref(ex, "List", "type")).toMatchObject({
      receiver: "java.util",
      receiverKind: "member-chain",
    });
    expect(ref(ex, "Entry", "type")).toMatchObject({ receiver: "Map", receiverKind: "identifier" });
    expect(ref(ex, "Inner", "type")).toMatchObject({ receiver: "Outer" });
  });

  it("emits annotations as type references, skipping java.lang ones", async () => {
    const ex = await extract(`@Entity
@a.b.Table(name = "x")
class A {
  @Override @Deprecated @FunctionalInterface @SuppressWarnings("all")
  public String toString() { return ""; }
  @Autowired private Repo repo;
  @Test(expected = Boom.class) void t(@Valid Req r) {}
}
`);
    expect(ref(ex, "Entity", "type").fromLocalId).toBe("A");
    expect(ref(ex, "Table", "type")).toMatchObject({ receiver: "a.b" });
    for (const skipped of ["Override", "Deprecated", "FunctionalInterface", "SuppressWarnings"]) {
      expect(refs(ex, skipped)).toHaveLength(0);
    }
    expect(ref(ex, "Autowired", "type").fromLocalId).toBe("A");
    expect(ref(ex, "Test", "type").fromLocalId).toBe("A.t");
    expect(ref(ex, "Boom", "type")).toBeDefined();
    expect(ref(ex, "Valid", "type")).toBeDefined();
  });
});

describe("java receiverTypeHint", () => {
  it("uses locals, var, parameters, fields, enhanced-for and catch variables", async () => {
    const ex = await extract(`class A {
  private final Repo repo;
  private Map<String, User> byName;
  Svc[] many;
  void f(Param p, List<Item> items) {
    Foo x = make();
    var y = new Bar<>();
    var z = make();
    p.a();
    x.b();
    y.c();
    z.d();
    repo.e();
    byName.f();
    this.repo.g();
    many.h();
    for (Item it : items) { it.i(); }
    try { } catch (BadThing ex) { ex.j(); }
    ((Cast) obj).k();
    new Made().l();
  }
}
`);
    const hint = (name: string): string | undefined => ref(ex, name, "call").receiverTypeHint;
    expect(hint("a")).toBe("Param");
    expect(hint("b")).toBe("Foo");
    expect(hint("c")).toBe("Bar");
    expect(hint("d")).toBeUndefined();
    expect(hint("e")).toBe("Repo");
    expect(hint("f")).toBe("Map");
    expect(hint("g")).toBe("Repo");
    expect(hint("h")).toBeUndefined();
    expect(hint("i")).toBe("Item");
    expect(hint("j")).toBe("BadThing");
    expect(hint("k")).toBe("Cast");
    expect(hint("l")).toBe("Made");
  });

  it("lets a local or parameter shadow a field, and outer fields reach inner classes", async () => {
    const ex = await extract(`class Outer {
  private Repo repo;
  class Inner {
    void f() { repo.a(); }
  }
  void g(Other repo) { repo.b(); }
  void h() { Local repo = null; repo.c(); }
}
`);
    expect(ref(ex, "a").receiverTypeHint).toBe("Repo");
    expect(ref(ex, "b").receiverTypeHint).toBe("Other");
    expect(ref(ex, "c").receiverTypeHint).toBe("Local");
  });

  it("keeps qualified type names as written", async () => {
    const ex = await extract(
      "class A { void f(java.util.List<X> l, Map.Entry<K, V> e) { l.a(); e.b(); } }\n",
    );
    expect(ref(ex, "a").receiverTypeHint).toBe("java.util.List");
    expect(ref(ex, "b").receiverTypeHint).toBe("Map.Entry");
  });
});
