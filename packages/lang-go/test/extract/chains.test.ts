import { describe, expect, it } from "vitest";
import { def, extract, ref } from "./helpers.ts";

describe("go extraction: chain receiver hints", () => {
  it("hints call chains and field chains through a variable's type", async () => {
    const ex = await extract(`package p
func F(r *Router, s Server) {
	r.Route("/").Methods("GET").Name("x")
	s.limiter.Allow()
	NewRouter().Route("/").Methods("PUT")
	route := r.Route("/a")
	route.Methods("POST")
}
`);
    // The receiver of Name is `r.Route("/").Methods("GET")`.
    expect(ref(ex, "Name").receiverTypeHint).toBe("Router/m:Route/m:Methods");
    expect(ref(ex, "Allow").receiverTypeHint).toBe("Server/f:limiter");
    expect(ref(ex, "Methods").receiverTypeHint).toBe("Router/m:Route");
    const put = ex.references.find((r) => r.name === "Methods" && r.line === 5);
    expect(put?.receiverTypeHint).toBe("call:NewRouter/m:Route");
    const post = ex.references.find((r) => r.name === "Methods" && r.line === 7);
    expect(post?.receiverTypeHint).toBe("Router/m:Route");
  });

  it("uses the method receiver variable as the base of a chain", async () => {
    const ex = await extract(`package p
func (s *Server) Run() {
	s.store.Open().Close()
}
`);
    expect(ref(ex, "Close").receiverTypeHint).toBe("Server/f:store/m:Open");
  });

  it("gives alternatives for a variable with several typed bindings", async () => {
    const ex = await extract(`package p
func F(n int) {
	x := NewA()
	if n > 0 {
		x = &B{}
	}
	x.Do()
}
`);
    expect(ref(ex, "Do").receiverTypeHint?.split("|").sort()).toEqual(["B", "call:NewA"]);
  });

  it("turns an unbound variable into a package variable hint", async () => {
    const ex = await extract(`package p
func F() {
	Form.Bind()
	other.Field.Do()
	pkg.New().Run()
}
`);
    expect(ref(ex, "Bind").receiverTypeHint).toBe("pkgvar:Form");
    expect(ref(ex, "Do").receiverTypeHint).toBe("pkgvar:other/f:Field");
    expect(ref(ex, "Run").receiverTypeHint).toBe("call:pkg.New");
  });

  it("records struct field types as go.fields (named types only, embedded by type name)", async () => {
    const ex = await extract(`package p
type Server struct {
	Base
	*pkg.Other
	store  Store
	conn   *net.Conn
	a, b   Item
	names  []string
	n      int
	hook   func()
}
`);
    expect(def(ex, "Server").meta?.["go.fields"]).toEqual({
      Base: "Base",
      Other: "pkg.Other",
      store: "Store",
      conn: "net.Conn",
      a: "Item",
      b: "Item",
    });
  });

  it("records package-level variable hints as go.vars", async () => {
    const ex = await extract(`package p
var Form = formBinding{}
var client = NewClient()
var (
	Json Binding = jsonBinding{}
	count = 3
)
func F() { x := 1; _ = x }
`);
    expect(ex.meta?.["go.vars"]).toEqual({
      Form: "formBinding",
      client: "call:NewClient",
      Json: "Binding",
    });
  });
});
