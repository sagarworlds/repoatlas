import { describe, expect, it } from "vitest";
import { extract, ref, refs } from "./helpers.ts";

describe("python call references", () => {
  it("classifies receivers", async () => {
    const ex = await extract(`
class A(Base):
    def m(self):
        helper(1, 2)
        self.go()
        cls.make()
        obj.run()
        a.b.c()
        make().chain()
        super().__init__()
        super(A, self).__init__()
`);
    expect(ref(ex, "helper")).toMatchObject({ fromLocalId: "A.m", argCount: 2 });
    expect(ref(ex, "helper").receiver).toBeUndefined();
    expect(ref(ex, "go")).toMatchObject({ receiver: "self", receiverKind: "self" });
    expect(ref(ex, "make", "call")).toMatchObject({ receiver: "cls", receiverKind: "self" });
    expect(ref(ex, "run")).toMatchObject({ receiver: "obj", receiverKind: "identifier" });
    expect(ref(ex, "c")).toMatchObject({ receiver: "a.b", receiverKind: "member-chain" });
    expect(ref(ex, "chain")).toMatchObject({ receiver: "make()", receiverKind: "call" });
    const inits = refs(ex, "__init__");
    expect(inits.map((r) => r.receiverKind)).toEqual(["super", "super"]);
    expect(inits.map((r) => r.receiver)).toEqual(["super()", "super(A, self)"]);
  });

  it("does not emit a reference for the bare super() call itself", async () => {
    const ex = await extract("class A(B):\n    def m(self):\n        super().m()\n");
    expect(refs(ex, "super")).toEqual([]);
  });

  it("attributes calls in lambdas, comprehensions and nested functions to the named definition", async () => {
    const ex = await extract(`
def outer():
    f = lambda: one()
    xs = [two(x) for x in range(3)]
    def inner():
        three()
`);
    expect(ref(ex, "one").fromLocalId).toBe("outer");
    expect(ref(ex, "two").fromLocalId).toBe("outer");
    expect(ref(ex, "three").fromLocalId).toBe("outer.inner");
  });

  it("leaves module-level calls without fromLocalId", async () => {
    const ex = await extract("main()\nif x:\n    run()\n");
    expect(ref(ex, "main").fromLocalId).toBeUndefined();
    expect(ref(ex, "run").fromLocalId).toBeUndefined();
  });

  it("counts a lone generator argument as no argCount", async () => {
    const ex = await extract("total(x for x in y)\n");
    expect(ref(ex, "total").argCount).toBeUndefined();
  });
});

describe("python decorator and base-class references", () => {
  it("attributes decorators to the parent scope of the decorated definition", async () => {
    const ex = await extract(`
@register
@app.route("/x")
def view(): pass

class K:
    @helper.wrap
    def m(self): pass

    @staticmethod
    @property
    def n(): pass
`);
    expect(ref(ex, "register")).toMatchObject({ kind: "call" });
    expect(ref(ex, "register").fromLocalId).toBeUndefined();
    expect(ref(ex, "route")).toMatchObject({ receiver: "app", argCount: 1 });
    expect(ref(ex, "route").fromLocalId).toBeUndefined();
    expect(ref(ex, "wrap")).toMatchObject({ receiver: "helper", fromLocalId: "K" });
    expect(refs(ex, "staticmethod")).toEqual([]);
    expect(refs(ex, "property")).toEqual([]);
  });

  it("emits extends with receiver split for dotted and subscripted bases", async () => {
    const ex = await extract(`
class A(Base, models.Model, Generic[T], pkg.sub.Base[int], metaclass=Meta, object):
    pass
`);
    const ext = refs(ex, "Base", "extends");
    expect(ext).toHaveLength(2);
    expect(ext[0]).toMatchObject({ kind: "extends", fromLocalId: "A" });
    expect(ext[0]?.receiver).toBeUndefined();
    expect(ext[1]).toMatchObject({ receiver: "pkg.sub", receiverKind: "member-chain" });
    expect(ref(ex, "Model", "extends")).toMatchObject({ receiver: "models" });
    expect(refs(ex, "Generic")).toEqual([]);
    expect(refs(ex, "object")).toEqual([]);
  });
});

describe("python type references", () => {
  it("emits type refs for parameter, return and variable annotations", async () => {
    const ex = await extract(`
class C:
    owner: User
    def m(self, a: Order, b: "Item", c: int = 1) -> Optional[models.Result]:
        local: Cart = make()
`);
    const types = ex.references.filter((r) => r.kind === "type");
    expect(types.map((r) => [r.name, r.receiver, r.fromLocalId])).toEqual([
      ["User", undefined, "C"],
      ["Order", undefined, "C.m"],
      ["Item", undefined, "C.m"],
      ["Result", "models", "C.m"],
      ["Cart", undefined, "C.m"],
    ]);
  });

  it("skips builtin and typing names, unwraps containers", async () => {
    const ex = await extract(`
def f(
    a: int,
    b: List[str],
    c: Dict[str, Widget],
    d: Widget | None,
    e: Literal["x"],
) -> None:
    pass
`);
    const types = ex.references.filter((r) => r.kind === "type").map((r) => r.name);
    expect(types).toEqual(["Widget", "Widget"]);
  });
});

describe("python receiverTypeHint", () => {
  it("infers from a constructor assignment", async () => {
    const ex = await extract(`
def f():
    u = User(1)
    u.save()
    w = models.Widget()
    w.draw()
`);
    expect(ref(ex, "save").receiverTypeHint).toBe("User");
    expect(ref(ex, "draw").receiverTypeHint).toBe("models.Widget");
  });

  it("infers from variable and parameter annotations, unwrapping Optional and None unions", async () => {
    const ex = await extract(`
def f(a: User, b: Optional[Order], c: "Item", d: Cart | None, e: list[User], g: int):
    x: Thing = build()
    a.m1(); b.m2(); c.m3(); d.m4(); e.m5(); g.m6(); x.m7()
`);
    expect(ref(ex, "m1").receiverTypeHint).toBe("User");
    expect(ref(ex, "m2").receiverTypeHint).toBe("Order");
    expect(ref(ex, "m3").receiverTypeHint).toBe("Item");
    expect(ref(ex, "m4").receiverTypeHint).toBe("Cart");
    expect(ref(ex, "m5").receiverTypeHint).toBeUndefined();
    expect(ref(ex, "m6").receiverTypeHint).toBeUndefined();
    expect(ref(ex, "m7").receiverTypeHint).toBe("Thing");
  });

  it("is conservative when the variable is bound to something else", async () => {
    const ex = await extract(`
def f(p: User):
    x = Foo()
    x = Bar()
    x.one()
    y = Foo()
    y = compute()
    y.two()
    p = other
    p.three()
    for z in items:
        pass
    z.four()
    k = Foo()
    k.five()
    k.five()
`);
    expect(ref(ex, "one").receiverTypeHint).toBeUndefined();
    expect(ref(ex, "two").receiverTypeHint).toBeUndefined();
    expect(ref(ex, "three").receiverTypeHint).toBeUndefined();
    expect(ref(ex, "four").receiverTypeHint).toBeUndefined();
    expect(refs(ex, "five").map((r) => r.receiverTypeHint)).toEqual(["Foo", "Foo"]);
  });

  it("accepts repeated identical constructors and lowercase factories give no hint", async () => {
    const ex = await extract(`
def f():
    a = Foo()
    a = Foo()
    a.one()
    b = make_foo()
    b.two()
`);
    expect(ref(ex, "one").receiverTypeHint).toBe("Foo");
    expect(ref(ex, "two").receiverTypeHint).toBeUndefined();
  });

  it("does not leak hints between functions and sees enclosing function variables", async () => {
    const ex = await extract(`
def f():
    u = User()
    def inner():
        u.save()
def g():
    u.other()
`);
    expect(ref(ex, "save").receiverTypeHint).toBe("User");
    expect(ref(ex, "other").receiverTypeHint).toBeUndefined();
  });

  it("works at module level and gives no hint for self receivers", async () => {
    const ex = await extract(`
svc = Service()
svc.start()
class A:
    def m(self):
        self.x()
`);
    expect(ref(ex, "start").receiverTypeHint).toBe("Service");
    expect(ref(ex, "x").receiverTypeHint).toBeUndefined();
  });
});
