import { describe, expect, it } from "vitest";
import { def, extract } from "./helpers.ts";

const SERVER = `package server

import "context"

// Server runs things.
type Server struct {
	Base
	name string
}

type Store interface {
	Get(key string) (string, error)
	Put(key, value string) error
	io.Closer
}

type ID int
type Handler func(w Writer, r *Request)
type Alias = Server
type Pair[K comparable, V any] struct {
	Key K
	Val V
}

func NewServer(addr string) *Server {
	return &Server{}
}

func (s *Server) Start(ctx context.Context) error {
	return nil
}

func (s Server) Name() string { return s.name }

func (p *Pair[K, V]) Swap() {}

func Map[K comparable, V any](m map[K]V) []V { return nil }

func init() {}
func init() {}
`;

describe("go definitions", () => {
  it("extracts functions, types and methods with the documented localIds", async () => {
    const ex = await extract(SERVER);
    expect(ex.parseErrors).toBe(0);
    expect(ex.language).toBe("go");
    expect(ex.definitions.map((d) => d.localId)).toEqual([
      "Server",
      "Store",
      "ID",
      "Handler",
      "Alias",
      "Pair",
      "NewServer",
      "Server.Start",
      "Server.Name",
      "Pair.Swap",
      "Map",
      "init",
      "init@40",
    ]);
  });

  it("maps struct, interface and other named types to kinds", async () => {
    const ex = await extract(SERVER);
    expect(def(ex, "Server").kind).toBe("class");
    expect(def(ex, "Store").kind).toBe("interface");
    expect(def(ex, "ID").kind).toBe("class");
    expect(def(ex, "ID").meta?.["go.kind"]).toBe("alias");
    expect(def(ex, "Handler").meta?.["go.kind"]).toBe("alias");
    expect(def(ex, "Alias").meta?.["go.kind"]).toBe("alias");
    expect(def(ex, "Server").meta?.["go.kind"]).toBeUndefined();
    expect(def(ex, "Pair").kind).toBe("class");
  });

  it("lists interface methods in meta but does not emit them as definitions", async () => {
    const ex = await extract(SERVER);
    expect(def(ex, "Store").meta?.["go.methods"]).toEqual(["Get", "Put"]);
    expect(ex.definitions.some((d) => d.name === "Get")).toBe(false);
  });

  it("names methods Receiver.Method with star and generics stripped", async () => {
    const ex = await extract(SERVER);
    const start = def(ex, "Server.Start");
    expect(start.kind).toBe("method");
    expect(start.name).toBe("Start");
    expect(start.parentLocalId).toBe("Server");
    expect(start.meta?.["go.receiver"]).toBe("Server");
    expect(def(ex, "Server.Name").parentLocalId).toBe("Server");
    expect(def(ex, "Pair.Swap").parentLocalId).toBe("Pair");
    expect(def(ex, "Pair.Swap").meta?.["go.receiver"]).toBe("Pair");
  });

  it("leaves the parent empty when the receiver type is in another file", async () => {
    const ex = await extract("package server\n\nfunc (s *Server) Stop() {}\n", "pkg/stop.go");
    const stop = def(ex, "Server.Stop");
    expect(stop.kind).toBe("method");
    expect(stop.parentLocalId).toBeUndefined();
    expect(stop.meta?.["go.receiver"]).toBe("Server");
  });

  it("builds one-line signatures without bodies", async () => {
    const ex = await extract(SERVER);
    expect(def(ex, "NewServer").signature).toBe("func NewServer(addr string) *Server");
    expect(def(ex, "Server.Start").signature).toBe(
      "func (s *Server) Start(ctx context.Context) error",
    );
    expect(def(ex, "Map").signature).toBe("func Map[K comparable, V any](m map[K]V) []V");
    expect(def(ex, "Server").signature).toBe("type Server struct");
    expect(def(ex, "Store").signature).toBe("type Store interface");
    expect(def(ex, "ID").signature).toBe("type ID int");
    expect(def(ex, "Pair").signature).toBe("type Pair[K comparable, V any] struct");
    expect(def(ex, "Alias").signature).toBe("type Alias = Server");
  });

  it("truncates very long signatures to 300 characters", async () => {
    const params = Array.from({ length: 80 }, (_, i) => `argument${i} int`).join(", ");
    const ex = await extract(`package p\nfunc Long(${params}) {}\n`);
    expect((def(ex, "Long").signature ?? "").length).toBeLessThanOrEqual(300);
  });

  it("sets visibility, export, loc and spans", async () => {
    const ex = await extract(SERVER);
    expect(def(ex, "NewServer").meta).toMatchObject({
      visibility: "public",
      isExported: true,
      loc: 3,
    });
    expect(def(ex, "init").meta).toMatchObject({ visibility: "private", isExported: false });
    expect(def(ex, "NewServer").span).toEqual({ startLine: 25, endLine: 27 });
    expect(def(ex, "Server").meta?.isStatic).toBeUndefined();
  });

  it("handles grouped type declarations", async () => {
    const ex = await extract("package p\n\ntype (\n\tA struct{}\n\tb interface{ M() }\n)\n");
    expect(def(ex, "A").kind).toBe("class");
    expect(def(ex, "b").kind).toBe("interface");
    expect(def(ex, "b").meta).toMatchObject({ visibility: "private", isExported: false });
  });

  it("disambiguates duplicate methods and keeps nothing local", async () => {
    const ex = await extract(
      "package p\ntype T struct{}\nfunc (t T) M() {}\nfunc (t *T) M() {}\nfunc f() {\n\ttype local struct{}\n}\n",
    );
    expect(ex.definitions.map((d) => d.localId)).toEqual(["T", "T.M", "T.M@4", "f"]);
  });

  it("marks test files and generated files", async () => {
    const test = await extract(
      "package p_test\nfunc TestX(t *testing.T) {}\nfunc helper() {}\n",
      "pkg/x_test.go",
    );
    expect(def(test, "TestX").meta?.isTest).toBe(true);
    expect(def(test, "helper").meta?.isTest).toBe(true);
    expect(test.meta).toMatchObject({ "go.package": "p_test", "go.test": true });
    const gen = await extract(
      "// Code generated by protoc. DO NOT EDIT.\n\npackage p\nfunc F() {}\n",
    );
    expect(def(gen, "F").meta?.isGenerated).toBe(true);
    expect(gen.meta?.["go.generated"]).toBe(true);
    const plain = await extract("package p\nfunc F() {}\n");
    expect(def(plain, "F").meta?.isTest).toBeUndefined();
    expect(plain.meta).toEqual({ "go.package": "p" });
  });
});
