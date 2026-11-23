import { describe, expect, it } from "vitest";
import { edgeBetween, goFile, run, sym } from "./helpers.ts";

const GO_MOD = "module example.com/app\n";

/** Types: Router.Route() returns *Route, Route.Methods() returns *Route, Route has a Limit field. */
const ROUTING = goFile("svc/routing.go", {
  defs: {
    Router: { kind: "class", meta: { "go.fields": { route: "Route", limiter: "Limiter" } } },
    Route: "class",
    Limiter: "class",
    NewRouter: { kind: "function", signature: "func NewRouter() *Router" },
    "Router.Route": { kind: "method", signature: "func (r *Router) Route(p string) *Route" },
    "Router.Walk": { kind: "method", signature: "func (r *Router) Walk()" },
    "Route.Methods": { kind: "method", signature: "func (r *Route) Methods(m ...string) *Route" },
    "Route.Name": { kind: "method", signature: "func (r *Route) Name(n string) *Route" },
    "Limiter.Allow": { kind: "method", signature: "func (l *Limiter) Allow() bool" },
    "Other.Name": { kind: "method", signature: "func (o *Other) Name() string" },
    Other: "class",
  },
});

function call(name: string, hint: string, line: number) {
  return {
    name,
    receiver: "x",
    receiverKind: "call" as const,
    receiverTypeHint: hint,
    fromLocalId: "use",
    line,
  };
}

describe("go receiver hints: chains", () => {
  it("follows method result types: r.Route(p).Methods(m).Name(n)", async () => {
    const use = goFile("svc/use.go", {
      defs: { use: "function" },
      refs: [
        call("Methods", "Router/m:Route", 10),
        call("Name", "Router/m:Route/m:Methods", 11),
        call("Name", "call:NewRouter/m:Route/m:Methods", 12),
      ],
    });
    const { result } = await run([ROUTING, use], { "go.mod": GO_MOD });
    const methods = sym("svc/routing.go", "Route.Methods");
    const name = sym("svc/routing.go", "Route.Name");
    const edges = result.edges.filter((e) => e.src === sym("svc/use.go", "use"));
    expect(edges.find((e) => e.dst === methods)).toMatchObject({
      confidence: "inferred",
      line: 10,
    });
    // Route.Name, not Other.Name: the chain's type decided it, so this is not a name-match.
    expect(edges.filter((e) => e.dst === name).map((e) => e.line)).toEqual([11, 12]);
    expect(edges.every((e) => e.confidence === "inferred")).toBe(true);
    expect(
      edgeBetween(result.edges, sym("svc/use.go", "use"), sym("svc/routing.go", "Other.Name")),
    ).toBeUndefined();
  });

  it("follows struct fields from a variable type: r.limiter.Allow()", async () => {
    const use = goFile("svc/use.go", {
      defs: { use: "function" },
      refs: [call("Allow", "Router/f:limiter", 10)],
    });
    const { result } = await run([ROUTING, use], { "go.mod": GO_MOD });
    expect(
      edgeBetween(result.edges, sym("svc/use.go", "use"), sym("svc/routing.go", "Limiter.Allow")),
    ).toMatchObject({ confidence: "inferred" });
  });

  it("does not count a call through an external field type as a repository call", async () => {
    const types = goFile("svc/types.go", {
      imports: [{ specifier: "net/http" }],
      defs: {
        Context: { kind: "class", meta: { "go.fields": { Request: "http.Request" } } },
        "Context.Name": { kind: "method", signature: "func (c *Context) Name() string" },
      },
    });
    const use = goFile("svc/use.go", {
      defs: { use: "function" },
      refs: [call("Name", "Context/f:Request/f:Header", 10)],
    });
    const { result, summary } = await run([types, use], { "go.mod": GO_MOD });
    expect(result.edges).toEqual([]);
    expect(summary.byReason.external).toBe(1);
  });

  it("falls back to name-match when a step is unknown", async () => {
    const use = goFile("svc/use.go", {
      defs: { use: "function" },
      refs: [call("Name", "Router/m:Missing", 10)],
    });
    const { result } = await run([ROUTING, use], { "go.mod": GO_MOD });
    const edges = result.edges.filter((e) => e.src === sym("svc/use.go", "use"));
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.confidence === "name-match")).toBe(true);
  });
});

describe("go receiver hints: alternatives", () => {
  it("accepts alternatives that lead to the same type", async () => {
    const use = goFile("svc/use.go", {
      defs: { use: "function" },
      refs: [call("Methods", "Router/m:Route|Route", 10)],
    });
    const { result } = await run([ROUTING, use], { "go.mod": GO_MOD });
    expect(
      edgeBetween(result.edges, sym("svc/use.go", "use"), sym("svc/routing.go", "Route.Methods")),
    ).toMatchObject({ confidence: "inferred" });
  });

  it("rejects alternatives that lead to different types", async () => {
    const use = goFile("svc/use.go", {
      defs: { use: "function" },
      refs: [call("Name", "Route|Other", 10)],
    });
    const { result } = await run([ROUTING, use], { "go.mod": GO_MOD });
    const edges = result.edges.filter((e) => e.src === sym("svc/use.go", "use"));
    expect(edges.every((e) => e.confidence === "name-match")).toBe(true);
  });
});

describe("go receiver hints: package-level variables", () => {
  const binding = goFile("bind/binding.go", {
    defs: {
      Form: { kind: "class" },
      "Form.Bind": { kind: "method", signature: "func (Form) Bind() error" },
      Json: { kind: "class" },
      "Json.Bind": { kind: "method", signature: "func (Json) Bind() error" },
    },
  });
  binding.meta = { ...binding.meta, "go.vars": { FormBinding: "Form", Mk: "call:newJson" } };

  it("types a variable declared in another file of the package", async () => {
    const use = goFile("bind/use.go", {
      defs: { use: "function" },
      refs: [
        {
          name: "Bind",
          receiver: "FormBinding",
          receiverKind: "identifier",
          receiverTypeHint: "pkgvar:FormBinding",
          fromLocalId: "use",
          line: 10,
        },
      ],
    });
    const { result } = await run([binding, use], { "go.mod": GO_MOD });
    const edges = result.edges.filter((e) => e.src === sym("bind/use.go", "use"));
    expect(edges.map((e) => e.dst)).toEqual([sym("bind/binding.go", "Form.Bind")]);
    expect(edges[0]?.confidence).toBe("inferred");
  });

  it("types an exported variable of an imported package: bind.FormBinding.Bind()", async () => {
    const use = goFile("app/main.go", {
      imports: [{ specifier: "example.com/app/bind" }],
      defs: { use: "function" },
      refs: [
        {
          name: "Bind",
          receiver: "bind.FormBinding",
          receiverKind: "member-chain",
          receiverTypeHint: "pkgvar:bind/f:FormBinding",
          fromLocalId: "use",
          line: 10,
        },
      ],
    });
    const { result } = await run([binding, use], { "go.mod": GO_MOD });
    const edges = result.edges.filter((e) => e.src === sym("app/main.go", "use"));
    expect(edges.map((e) => e.dst)).toEqual([sym("bind/binding.go", "Form.Bind")]);
  });

  it("does not see an unexported variable of an imported package", async () => {
    binding.meta = { ...binding.meta, "go.vars": { formBinding: "Form" } };
    const use = goFile("app/main.go", {
      imports: [{ specifier: "example.com/app/bind" }],
      defs: { use: "function" },
      refs: [
        {
          name: "Bind",
          receiver: "bind.formBinding",
          receiverKind: "member-chain",
          receiverTypeHint: "pkgvar:bind/f:formBinding",
          fromLocalId: "use",
          line: 10,
        },
      ],
    });
    const { result } = await run([binding, use], { "go.mod": GO_MOD });
    const edges = result.edges.filter((e) => e.src === sym("app/main.go", "use"));
    expect(edges.every((e) => e.confidence === "name-match")).toBe(true);
  });
});

describe("go receiver hints: conversions", () => {
  it("types T(x) as T when T is a repository type", async () => {
    const use = goFile("svc/use.go", {
      defs: { use: "function" },
      refs: [call("Methods", "call:Route", 10)],
    });
    const { result } = await run([ROUTING, use], { "go.mod": GO_MOD });
    expect(
      edgeBetween(result.edges, sym("svc/use.go", "use"), sym("svc/routing.go", "Route.Methods")),
    ).toMatchObject({ confidence: "inferred" });
  });
});
