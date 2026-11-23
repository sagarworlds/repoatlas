import { describe, expect, it } from "vitest";
import { parseResultType, parseTypeName } from "../../src/resolve/index.ts";

describe("parseTypeName", () => {
  it("strips pointers, generics and variadic dots", () => {
    expect(parseTypeName("*Server")).toEqual({ qualifier: undefined, name: "Server" });
    expect(parseTypeName("pkg.Client[T, U]")).toEqual({ qualifier: "pkg", name: "Client" });
    expect(parseTypeName("...Item")).toEqual({ qualifier: undefined, name: "Item" });
  });

  it("gives undefined for types without a single name", () => {
    for (const text of [
      "[]Item",
      "map[string]int",
      "chan int",
      "func()",
      "interface{}",
      "struct{}",
    ]) {
      expect(parseTypeName(text)).toBeUndefined();
    }
  });
});

describe("parseResultType", () => {
  it("reads single, tuple and named results", () => {
    expect(parseResultType("func NewServer(addr string) *Server")).toEqual({
      qualifier: undefined,
      name: "Server",
    });
    expect(parseResultType("func Open(p string) (*store.Store, error)")).toEqual({
      qualifier: "store",
      name: "Store",
    });
    expect(parseResultType("func New() (s *Server, err error)")).toEqual({
      qualifier: undefined,
      name: "Server",
    });
    expect(parseResultType("func New[T any](v T) *Box[T]")).toEqual({
      qualifier: undefined,
      name: "Box",
    });
    expect(parseResultType("func (c *Client) Dial() (*Conn, error)")).toEqual({
      qualifier: undefined,
      name: "Conn",
    });
  });

  it("gives undefined when there is no named result", () => {
    expect(parseResultType("func Run()")).toBeUndefined();
    expect(parseResultType("func Names() []string")).toBeUndefined();
    expect(parseResultType("not a signature")).toBeUndefined();
  });
});
