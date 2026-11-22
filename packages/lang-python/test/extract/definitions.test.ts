import { describe, expect, it } from "vitest";
import { def, extract } from "./helpers.ts";

describe("python definitions", () => {
  it("emits classes, methods, functions and nested ids", async () => {
    const ex = await extract(`
class Order:
    class Status:
        def label(self):
            pass

    def total(self):
        def helper():
            pass
        return helper()

def top():
    pass
`);
    expect(ex.definitions.map((d) => [d.localId, d.kind, d.parentLocalId])).toEqual([
      ["Order", "class", undefined],
      ["Order.Status", "class", "Order"],
      ["Order.Status.label", "method", "Order.Status"],
      ["Order.total", "method", "Order"],
      ["Order.total.helper", "function", "Order.total"],
      ["top", "function", undefined],
    ]);
    expect(ex.parseErrors).toBe(0);
  });

  it("builds one-line signatures", async () => {
    const ex = await extract(`
class User(Base, models.Mixin, metaclass=Meta):
    async def save(
        self,
        force: bool = False,  # a comment
        *args,
        **kw,
    ) -> None:
        pass

def plain():
    pass

def kw(a, /, b, *, c: "Foo" = None):
    pass
`);
    expect(def(ex, "User").signature).toBe("class User(Base, models.Mixin, metaclass=Meta)");
    expect(def(ex, "User.save").signature).toBe(
      "async save(self, force: bool = False, *args, **kw) -> None",
    );
    expect(def(ex, "plain").signature).toBe("plain()");
    expect(def(ex, "kw").signature).toBe('kw(a, /, b, *, c: "Foo" = None)');
  });

  it("starts the span at the def line, not at the decorator", async () => {
    const ex = await extract("@dec\n@dec2(1)\ndef f():\n    pass\n");
    expect(def(ex, "f").span).toEqual({ startLine: 3, endLine: 4 });
    expect(def(ex, "f").meta?.loc).toBe(2);
  });

  it("records decorators as written and classifies static/class/property", async () => {
    const ex = await extract(`
class C:
    @staticmethod
    def s(): pass

    @classmethod
    def c(cls): pass

    @property
    def p(self): pass

    @p.setter
    def p(self, v): pass

    @app.route("/x", methods=["GET"])
    @functools.lru_cache(maxsize=None)
    def r(self): pass

@dataclass
class D: pass
`);
    expect(def(ex, "C.s").meta).toMatchObject({
      isStatic: true,
      "py.decorators": ["staticmethod"],
    });
    expect(def(ex, "C.c").meta).toMatchObject({ isStatic: true, "py.classmethod": true });
    expect(def(ex, "C.p").meta).toMatchObject({ "py.property": true });
    expect(def(ex, "C.p@13").meta).toMatchObject({ "py.decorators": ["p.setter"] });
    expect(def(ex, "C.r").meta?.["py.decorators"]).toEqual(["app.route", "functools.lru_cache"]);
    expect(def(ex, "C.r").meta?.isStatic).toBeUndefined();
    expect(def(ex, "D").meta?.["py.decorators"]).toEqual(["dataclass"]);
  });

  it("disambiguates redefinitions with @line", async () => {
    const ex = await extract("def f(): pass\ndef f(): pass\n");
    expect(ex.definitions.map((d) => d.localId)).toEqual(["f", "f@2"]);
  });

  it("sets visibility, export and async metadata", async () => {
    const ex = await extract(`
def public(): pass
def _prot(): pass
async def fetch(): pass
class K:
    def __init__(self): pass
    def _p(self): pass
    def __q(self): pass
`);
    expect(def(ex, "public").meta).toMatchObject({ visibility: "public", isExported: true });
    expect(def(ex, "_prot").meta).toMatchObject({ visibility: "protected", isExported: false });
    expect(def(ex, "fetch").meta).toMatchObject({ isAsync: true });
    expect(def(ex, "public").meta?.isAsync).toBeUndefined();
    expect(def(ex, "K.__init__").meta?.visibility).toBe("public");
    expect(def(ex, "K._p").meta?.visibility).toBe("protected");
    expect(def(ex, "K.__q").meta?.visibility).toBe("private");
    expect(def(ex, "K._p").meta?.isExported).toBeUndefined();
  });

  it.each([
    ["tests/test_a.py", true],
    ["pkg/test_a.py", true],
    ["pkg/a_test.py", true],
    ["pkg/tests/helper.py", true],
    ["pkg/test/helper.py", true],
    ["pkg/conftest.py", true],
    ["pkg/a.py", false],
    ["pkg/latest.py", false],
  ])("isTest for %s is %s", async (path, expected) => {
    const ex = await extract("def f(): pass\nclass C:\n    def m(self): pass\n", path);
    expect(def(ex, "f").meta?.isTest === true).toBe(expected);
    expect(def(ex, "C.m").meta?.isTest === true).toBe(expected);
    expect(ex.meta?.isTest === true).toBe(expected);
  });
});
