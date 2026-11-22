import { describe, expect, it } from "vitest";
import { def, extract, refs } from "./helpers.ts";

describe("py.params and py.returns", () => {
  it("lists parameter names of every kind", async () => {
    const ex = await extract(
      "def f(a, b: int, c=1, d: str = 'x', *args, **kwargs):\n    pass\n\nclass C:\n    pass\n",
    );
    expect(def(ex, "f").meta?.["py.params"]).toEqual(["a", "b", "c", "d", "args", "kwargs"]);
    expect(def(ex, "C").meta?.["py.params"]).toBeUndefined();
  });

  it("takes the return annotation, unwrapping generators and Optional", async () => {
    const ex = await extract(
      "def a() -> Foo:\n    pass\n\ndef b() -> Iterator[Foo]:\n    pass\n\ndef c() -> Generator[Foo, None, None]:\n    pass\n\ndef d() -> Optional[Foo]:\n    pass\n\ndef e() -> list[Foo]:\n    pass\n",
    );
    expect(def(ex, "a").meta?.["py.returns"]).toBe("Foo");
    expect(def(ex, "b").meta?.["py.returns"]).toBe("Foo");
    expect(def(ex, "c").meta?.["py.returns"]).toBe("Foo");
    expect(def(ex, "d").meta?.["py.returns"]).toBe("Foo");
    expect(def(ex, "e").meta?.["py.returns"]).toBeUndefined();
  });

  it("infers the class from agreeing return and yield statements", async () => {
    const ex = await extract(
      "def a():\n    return Foo()\n\ndef b():\n    x = Foo()\n    yield x\n\ndef c(flag):\n    if flag:\n        return Foo()\n    return Bar()\n\ndef d():\n    def inner():\n        return Bar()\n    return Foo()\n\ndef e():\n    return make()\n",
    );
    expect(def(ex, "a").meta?.["py.returns"]).toBe("Foo");
    expect(def(ex, "b").meta?.["py.returns"]).toBe("Foo");
    expect(def(ex, "c").meta?.["py.returns"]).toBeUndefined();
    expect(def(ex, "d").meta?.["py.returns"]).toBe("Foo");
    expect(def(ex, "e").meta?.["py.returns"]).toBeUndefined();
  });
});

describe("receiver type hints", () => {
  it("hints the class of a constructor-call receiver", async () => {
    const ex = await extract("def f():\n    Foo().run()\n    mod.Bar().run()\n    make().run()\n");
    const hints = refs(ex, "run").map((r) => r.receiverTypeHint);
    expect(hints).toEqual(["Foo", "mod.Bar", undefined]);
  });

  it("hints self.x from assignments in any method, ignoring None", async () => {
    const ex = await extract(
      "class S:\n    def __init__(self, c: Client):\n        self.a = Foo()\n        self.b = None\n        self.c = c\n\n    def open(self):\n        self.b = Bar()\n\n    def go(self):\n        self.a.run()\n        self.b.run()\n        self.c.run()\n",
    );
    const hints = refs(ex, "run").map((r) => r.receiverTypeHint);
    expect(hints).toEqual(["Foo", "Bar", "Client"]);
  });

  it("gives no hint when assignments to self.x disagree or are augmented", async () => {
    const ex = await extract(
      "class S:\n    def __init__(self):\n        self.a = Foo()\n        self.a = Bar()\n        self.b = Foo()\n        self.b += other\n\n    def go(self):\n        self.a.run()\n        self.b.run()\n",
    );
    expect(refs(ex, "run").map((r) => r.receiverTypeHint)).toEqual([undefined, undefined]);
  });

  it("treats `x = None` as neutral for local variables", async () => {
    const ex = await extract("def f(flag):\n    x = None\n    x = Foo()\n    x.run()\n");
    expect(refs(ex, "run")[0]?.receiverTypeHint).toBe("Foo");
  });
});
