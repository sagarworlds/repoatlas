import { describe, expect, it } from "vitest";
import { extract, ref, refs } from "./helpers.ts";

const BODY = `package server

type Server struct {
	Base
	*pkg.Other
	Gen[int]
	c Client
}

type Iface interface {
	io.Reader
	Local
	Start(ctx context.Context) error
}

func (s *Server) Start(ctx context.Context, cl Client) error {
	x := &Foo{a: 1}
	y := pkg.Bar{}
	z := new(Baz)
	var q Quux
	s.c.Do()
	s.run(1, 2)
	cl.Ping()
	fmt.Println(x, y, z, q)
	go s.work()
	defer s.close()
	helper()
	NewThing().Go()
	return nil
}
`;

describe("go references: calls", () => {
  it("extracts calls with receivers, kinds and argument counts", async () => {
    const ex = await extract(BODY);
    expect(ex.parseErrors).toBe(0);
    expect(ref(ex, "helper", "call")).toMatchObject({
      fromLocalId: "Server.Start",
      argCount: 0,
    });
    expect(ref(ex, "helper", "call").receiver).toBeUndefined();
    expect(ref(ex, "Println", "call")).toMatchObject({
      receiver: "fmt",
      receiverKind: "identifier",
      argCount: 4,
    });
    expect(ref(ex, "Do", "call")).toMatchObject({ receiver: "s.c", receiverKind: "member-chain" });
    expect(ref(ex, "Go", "call")).toMatchObject({ receiver: "NewThing()", receiverKind: "call" });
  });

  it("marks calls on the method receiver variable as self (only inside methods)", async () => {
    const ex = await extract(BODY);
    expect(ref(ex, "run", "call")).toMatchObject({ receiver: "s", receiverKind: "self" });
    expect(ref(ex, "run", "call").receiverTypeHint).toBeUndefined();
    expect(ref(ex, "work", "call").receiverKind).toBe("self"); // go statement
    expect(ref(ex, "close", "call").receiverKind).toBe("self"); // defer statement
    const fn = await extract("package p\nfunc F(s *Server) {\n\ts.run()\n}\n");
    expect(ref(fn, "run", "call").receiverKind).toBe("identifier");
  });

  it("uses the declared receiver variable name, whatever it is", async () => {
    const ex = await extract("package p\nfunc (srv Server) A() {\n\tsrv.B()\n\ts.C()\n}\n");
    expect(ref(ex, "B").receiverKind).toBe("self");
    expect(ref(ex, "C").receiverKind).toBe("identifier");
  });

  it("attributes calls in function literals to the enclosing definition", async () => {
    const ex = await extract(
      "package p\nfunc F() {\n\tf := func() { inner() }\n\tf()\n}\nvar g = func() { top() }\n",
    );
    expect(ref(ex, "inner").fromLocalId).toBe("F");
    expect(ref(ex, "top").fromLocalId).toBeUndefined();
  });

  it("handles parenthesised callees and generic calls", async () => {
    const ex = await extract(
      "package p\nfunc F() {\n\t(f)(1)\n\t(s.m)(2)\n\tMap[int, string](x)\n\tpkg.Conv[int](y)\n}\n",
    );
    expect(ref(ex, "f", "call").fromLocalId).toBe("F");
    expect(ref(ex, "m", "call")).toMatchObject({ receiver: "s" });
    expect(ref(ex, "Map", "call").fromLocalId).toBe("F");
    expect(ref(ex, "Conv", "call")).toMatchObject({ receiver: "pkg" });
  });

  it("drops builtin calls and conversions to predeclared types", async () => {
    const ex = await extract(
      "package p\nfunc F(b []byte) {\n\tn := len(b)\n\ts := string(b)\n\tm := make(map[string]int)\n\tm = append(m)\n\tpanic(n)\n\tmin(1, 2)\n\t_ = s\n}\n",
    );
    const names = ex.references.filter((r) => r.kind === "call").map((r) => r.name);
    expect(names).toEqual(["min"]);
  });

  it("keeps a call to a same-file function named like a builtin", async () => {
    const ex = await extract("package p\nfunc len(x int) int { return x }\nfunc F() { len(1) }\n");
    expect(refs(ex, "len", "call")).toHaveLength(1);
  });
});

describe("go references: instantiate, embedding, types", () => {
  it("extracts composite literals and new(T) as instantiate", async () => {
    const ex = await extract(BODY);
    expect(ref(ex, "Foo", "instantiate").fromLocalId).toBe("Server.Start");
    expect(ref(ex, "Bar", "instantiate")).toMatchObject({
      receiver: "pkg",
      receiverKind: "identifier",
    });
    expect(ref(ex, "Baz", "instantiate").fromLocalId).toBe("Server.Start");
    expect(refs(ex, "Foo")).toHaveLength(1); // no extra type reference
    expect(refs(ex, "Baz")).toHaveLength(1);
  });

  it("extracts instantiation of generic types and skips elided elements", async () => {
    const ex = await extract(
      "package p\nfunc F() {\n\ta := Gen[int]{}\n\tb := []Item{{1}, {2}}\n\tc := map[string]*Node{}\n}\n",
    );
    expect(ref(ex, "Gen", "instantiate").line).toBe(3);
    expect(refs(ex, "Item", "instantiate")).toHaveLength(0);
    expect(ref(ex, "Item", "type").fromLocalId).toBe("F");
    expect(ref(ex, "Node", "type").fromLocalId).toBe("F");
    expect(refs(ex, "int")).toHaveLength(0);
  });

  it("extracts struct and interface embedding as extends", async () => {
    const ex = await extract(BODY);
    expect(ref(ex, "Base", "extends")).toMatchObject({ fromLocalId: "Server" });
    expect(ref(ex, "Other", "extends")).toMatchObject({ fromLocalId: "Server", receiver: "pkg" });
    expect(ref(ex, "Gen", "extends")).toMatchObject({ fromLocalId: "Server" });
    expect(ref(ex, "Reader", "extends")).toMatchObject({ fromLocalId: "Iface", receiver: "io" });
    expect(ref(ex, "Local", "extends")).toMatchObject({ fromLocalId: "Iface" });
    expect(refs(ex, "Base", "type")).toHaveLength(0);
    expect(refs(ex, "Local", "type")).toHaveLength(0);
    expect(ex.references.some((r) => r.kind === "implements")).toBe(false);
  });

  it("extracts type references from fields, params, results and var types", async () => {
    const ex = await extract(BODY);
    expect(ref(ex, "Client", "type")).toMatchObject({ fromLocalId: "Server" }); // field
    const clients = refs(ex, "Client", "type");
    expect(clients.map((c) => c.fromLocalId)).toEqual(["Server", "Server.Start"]);
    expect(ref(ex, "Quux", "type").fromLocalId).toBe("Server.Start");
    expect(ref(ex, "Context", "type")).toMatchObject({ receiver: "context" });
  });

  it("ignores predeclared types, receivers, declaration names and type parameters", async () => {
    const ex = await extract(`package p
type Box[T any] struct{ v T }
func (b *Box[T]) Get() T { var zero T; return zero }
func Map[K comparable, V Number](m map[K]V, n int, e error) []V { return nil }
func F() {
	type local struct{ n int }
	var l local
	_ = l
}
`);
    const typeNames = ex.references.filter((r) => r.kind === "type").map((r) => r.name);
    expect(typeNames).toEqual(["Number"]);
    expect(refs(ex, "Box")).toHaveLength(0);
  });

  it("drops references to local types", async () => {
    const ex = await extract(
      "package p\nfunc F() {\n\ttype local struct{}\n\tx := local{}\n\t_ = local(x)\n}\n",
    );
    expect(refs(ex, "local")).toHaveLength(0);
  });

  it("attaches package-level type uses and calls to no definition", async () => {
    const ex = await extract("package p\nvar d Client = NewClient()\nconst c = f()\n");
    expect(ref(ex, "Client", "type").fromLocalId).toBeUndefined();
    expect(ref(ex, "NewClient", "call").fromLocalId).toBeUndefined();
  });

  it("does not track function values passed as arguments", async () => {
    const ex = await extract("package p\nfunc F() {\n\tregister(handler)\n}\n");
    expect(refs(ex, "handler")).toHaveLength(0);
    expect(refs(ex, "register", "call")).toHaveLength(1);
  });
});

describe("go references: receiverTypeHint", () => {
  it("hints composite literals, new, var declarations and parameters", async () => {
    const ex = await extract(`package p
func F(c Client, p *Pool, n int) {
	a := &A{}
	b := B{}
	d := pkg.D{}
	e := new(E)
	var g G
	var h *H
	c.One()
	p.Two()
	a.Three()
	b.Four()
	d.Five()
	e.Six()
	g.Seven()
	h.Eight()
}
`);
    const hint = (n: string): string | undefined => ref(ex, n).receiverTypeHint;
    expect(hint("One")).toBe("Client");
    expect(hint("Two")).toBe("Pool");
    expect(hint("Three")).toBe("A");
    expect(hint("Four")).toBe("B");
    expect(hint("Five")).toBe("pkg.D");
    expect(hint("Six")).toBe("E");
    expect(hint("Seven")).toBe("G");
    expect(hint("Eight")).toBe("H");
  });

  it("gives a call hint for constructor results, alternatives for differing bindings and no hint for predeclared types", async () => {
    const ex = await extract(`package p
func F(n int) {
	x := NewX()
	y := &Y{}
	y = other()
	z := &Z{}
	z = nil
	x.A()
	y.B()
	z.C()
	n.D()
	s.f.E()
}
`);
    expect(ref(ex, "A").receiverTypeHint).toBe("call:NewX"); // resolver reads the signature
    // Differing bindings give alternatives: the resolver accepts them only if they agree.
    expect(ref(ex, "B").receiverTypeHint?.split("|").sort()).toEqual(["Y", "call:other"]);
    expect(ref(ex, "C").receiverTypeHint).toBe("Z"); // `z = nil` keeps the type
    expect(ref(ex, "D").receiverTypeHint).toBe("local:");
    expect(ref(ex, "E").receiverTypeHint).toBe("pkgvar:s/f:f"); // unbound: a package variable
  });

  it("hints type assertions, file-level vars and closures over outer variables", async () => {
    const ex = await extract(`package p
var client = &Client{}
func F(v any) {
	a := v.(*Alpha)
	b, ok := v.(Beta)
	a.One()
	b.Two()
	client.Three()
	run := func() { a.Four() }
	run()
	for _, item := range items {
		item.Five()
	}
}
`);
    expect(ref(ex, "One").receiverTypeHint).toBe("Alpha");
    expect(ref(ex, "Two").receiverTypeHint).toBe("Beta");
    expect(ref(ex, "Three").receiverTypeHint).toBe("Client");
    expect(ref(ex, "Four").receiverTypeHint).toBe("Alpha");
    expect(ref(ex, "Five").receiverTypeHint).toBe("local:");
  });

  it("hints the method receiver variable only through self, never as a hint", async () => {
    const ex = await extract("package p\nfunc (s *Server) M(c Cli) {\n\ts.A()\n\tc.B()\n}\n");
    expect(ref(ex, "A").receiverKind).toBe("self");
    expect(ref(ex, "A").receiverTypeHint).toBeUndefined();
    expect(ref(ex, "B").receiverTypeHint).toBe("Cli");
  });

  describe("go references: constructor hints", () => {
    it("hints qualified and multi-value constructor calls, but not builtins or conversions", async () => {
      const ex = await extract(`package p
func F(b []byte) {
	a := pkg.NewA()
	c, err := NewC()
	m := make(map[string]int)
	s := string(b)
	a.One()
	c.Two()
	m.Three()
	s.Four()
}
`);
      expect(ref(ex, "One").receiverTypeHint).toBe("call:pkg.NewA");
      expect(ref(ex, "Two").receiverTypeHint).toBe("call:NewC");
      expect(ref(ex, "Three").receiverTypeHint).toBe("local:");
      expect(ref(ex, "Four").receiverTypeHint).toBe("local:");
    });
  });
});
