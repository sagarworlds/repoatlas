import type { GraphEdge } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { extractJava } from "../../src/extract/index.ts";
import { run } from "./helpers.ts";

/** Extracts real Java sources, resolves them together and returns the result. */
async function analyze(files: Record<string, string>) {
  const extractions = [];
  for (const [path, content] of Object.entries(files)) {
    extractions.push(await extractJava({ path, content }));
  }
  const out = await run(extractions);
  return { ...out, extractions };
}

/** `Caller -> Callee` for every calls edge, without file paths and confidences. */
function calls(edges: GraphEdge[], withConfidence = false): string[] {
  return edges
    .filter((e) => e.kind === "calls")
    .map((e) => {
      const text = `${e.src.split("#")[1]} -> ${e.dst.split("#")[1]}`;
      return withConfidence ? `${text} (${e.confidence})` : text;
    })
    .sort();
}

describe("overloads picked by argument types", () => {
  const writer = `package p;
public class Writer {
  public void put(String s) {}
  public void put(Class<?> c) {}
  public void put(int n) {}
  public void put(double d) {}
  public void put(Writer w) {}
  public void put(Object o, Class<?> c) {}
  public void put(Object o, Appendable a) {}
  public void many(String... names) {}
  public void many(Iterable<String> names) {}
}
`;

  it("chooses by literals, class literals, declared variables and new", async () => {
    const user = `package p;
public class User {
  void go(Writer w, Writer other, String text, long big) {
    w.put("x");
    w.put(String.class);
    w.put(3);
    w.put(2.5);
    w.put(other);
    w.put(new Writer());
    w.put(text);
    w.put(null, Writer.class);
  }
}
`;
    const { result } = await analyze({ "p/Writer.java": writer, "p/User.java": user });
    const lines = calls(result.edges, true);
    expect(lines.filter((l) => l.startsWith("User.go -> Writer.put"))).toEqual(
      [
        "User.go -> Writer.put (inferred)", // "x"
        "User.go -> Writer.put (inferred)", // text
        "User.go -> Writer.put@4 (inferred)", // String.class is a Class
        "User.go -> Writer.put@5 (inferred)", // 3 (the int overload beats double)
        "User.go -> Writer.put@6 (inferred)", // 2.5
        "User.go -> Writer.put@7 (inferred)", // other
        "User.go -> Writer.put@7 (inferred)", // new Writer()
        "User.go -> Writer.put@8 (inferred)", // (null, Writer.class)
      ].sort(),
    );
  });

  it("a long variable widens to double, the only primitive overload that takes it", async () => {
    const user = `package p;
public class User {
  void go(Writer w, long big) {
    w.put(big);
  }
}
`;
    const { result } = await analyze({ "p/Writer.java": writer, "p/User.java": user });
    expect(calls(result.edges)).toEqual(["User.go -> Writer.put@6"]);
  });

  it("a constant like Mode.ON is only a hint: it favours the parameter of that type", async () => {
    const files = {
      "p/Box.java": `package p;
public class Box {
  public Box add(Mode... modes) { return this; }
  public Box add(Iterable<Mode> modes) { return this; }
}
`,
      "p/Mode.java": "package p;\npublic enum Mode { ON, OFF }\n",
      "p/User.java": `package p;
public class User {
  void go(Box b, Iterable<Mode> all) {
    b.add(Mode.ON);
    b.add(all);
  }
}
`,
    };
    const { result } = await analyze(files);
    expect(calls(result.edges)).toEqual(["User.go -> Box.add", "User.go -> Box.add@4"].sort());
  });

  it("stays ambiguous (name-match) when the argument type says nothing", async () => {
    const user = `package p;
public class User {
  void go(Writer w) {
    w.many(compute());
  }
  Object compute() { return null; }
}
`;
    const { result } = await analyze({ "p/Writer.java": writer, "p/User.java": user });
    const puts = result.edges.filter((e) => e.kind === "calls" && e.dst.includes("Writer.many"));
    expect(puts).toHaveLength(2); // the varargs and the Iterable overload
    expect(puts.every((e) => e.confidence === "name-match")).toBe(true);
  });
});

describe("call chains follow return types", () => {
  const files = {
    "p/Builder.java": `package p;
public class Builder {
  public static Builder create() { return new Builder(); }
  public Builder name(String n) { return this; }
  public Product build() { return new Product(); }
}
`,
    "p/Product.java": `package p;
public class Product {
  public String label() { return ""; }
  public Product build() { return this; }
}
`,
  };

  it("resolves .build() on the type the previous call returned", async () => {
    const user = `package p;
public class User {
  String go() {
    Product a = new Builder().name("x").build();
    return Builder.create().name("y").build().label();
  }
}
`;
    const { result } = await analyze({ ...files, "p/User.java": user });
    const found = calls(result.edges, true).filter((c) => c.startsWith("User.go"));
    expect(found).toContain("User.go -> Builder.build (inferred)");
    expect(found).toContain("User.go -> Product.label (inferred)");
    expect(found.some((c) => c.includes("Product.build"))).toBe(false);
    expect(found.some((c) => c.includes("name-match"))).toBe(false);
    expect(result.unresolved).toEqual([]);
  });

  it("follows a chain that starts at a typed variable and a this-field", async () => {
    const user = `package p;
public class User {
  private Builder b = new Builder();
  Product go(Builder other) {
    other.name("a").build();
    return this.b.name("z").build();
  }
}
`;
    const { result } = await analyze({ ...files, "p/User.java": user });
    expect(calls(result.edges).filter((c) => c === "User.go -> Builder.build")).toHaveLength(2);
  });

  it("treats a chain that starts with an external static import as external", async () => {
    const user = `package p;
import static com.google.common.truth.Truth.assertThat;
public class User {
  void go(String s) {
    assertThat(s).isEqualTo("a");
    assertThat(s).hasLength(1);
  }
}
`;
    const { result } = await analyze({ "p/User.java": user });
    expect(calls(result.edges)).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("a method returning an unknown generic type does not guess a target", async () => {
    const files2 = {
      "p/Box.java": `package p;
public class Box<T> {
  public T get() { return null; }
}
`,
      "p/Other.java": "package p;\npublic class Other { public void run() {} }\n",
      "p/User.java": `package p;
public class User {
  void go(Box<Other> box) {
    box.get().run();
  }
}
`,
    };
    const { result } = await analyze(files2);
    // T is unknown, so `run` is only name-matched, never inferred.
    const run = result.edges.filter((e) => e.kind === "calls" && e.dst.includes("Other.run"));
    expect(run.every((e) => e.confidence === "name-match")).toBe(true);
  });

  it("Foo.class.getName() is a java.lang.Class method, not a repository call", async () => {
    const files3 = {
      "p/Foo.java":
        'package p;\npublic class Foo { public String getSimpleName() { return ""; } }\n',
      "p/User.java": `package p;
public class User {
  String go() { return Foo.class.getSimpleName(); }
}
`,
    };
    const { result } = await analyze(files3);
    expect(calls(result.edges)).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});

describe("anonymous classes, local classes and inherited member types", () => {
  it("an unqualified call inside new Base() {...} finds the method of Base", async () => {
    const files = {
      "p/Module.java": `package p;
public abstract class Module {
  protected void bind(Class<?> c) {}
  protected abstract void configure();
}
`,
      "p/User.java": `package p;
public class User {
  Module make() {
    return new Module() {
      @Override protected void configure() {
        bind(String.class);
      }
    };
  }
}
`,
    };
    const { result } = await analyze(files);
    expect(calls(result.edges, true)).toEqual(["User.make -> Module.bind (inferred)"]);
    expect(result.unresolved).toEqual([]);
  });

  it("an unqualified call in an anonymous class of an external type is silent", async () => {
    const user = `package p;
import org.other.Base;
public class User {
  Object make() {
    return new Base() {
      void configure() { install(1); }
    };
  }
}
`;
    const { result } = await analyze({ "p/User.java": user });
    expect(calls(result.edges)).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("local classes and records have no node: references to them are silent", async () => {
    const user = `package p;
public class User {
  int go() {
    record Pair(int a, int b) {}
    class Helper { int twice(int n) { return n * 2; } }
    Pair pair = new Pair(1, 2);
    Helper helper = new Helper();
    return helper.twice(pair.a());
  }
}
`;
    const { result } = await analyze({ "p/User.java": user });
    expect(calls(result.edges)).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("a member type inherited from an external super class is not unresolved", async () => {
    const user = `package p;
import java.util.AbstractMap;
public class User extends AbstractMap<String, String> {
  Entry<String, String> first() { return null; }
}
`;
    const { result } = await analyze({ "p/User.java": user });
    expect(result.unresolved).toEqual([]);
  });

  it("java.lang exceptions and interfaces need no import", async () => {
    const user = `package p;
public class User {
  void go(Appendable out) throws NoSuchMethodException, IllegalAccessException {}
}
`;
    const { result } = await analyze({ "p/User.java": user });
    expect(result.unresolved).toEqual([]);
  });
});
