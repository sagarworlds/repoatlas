import { describe, expect, it } from "vitest";
import { extractGo } from "../src/extract/index.ts";
import { run, sym } from "./resolve/helpers.ts";

const GO_MOD = "module example.com/proj\n";

async function analyze(files: Record<string, string>) {
  const extractions = await Promise.all(
    Object.entries(files).map(([path, content]) => extractGo({ path, content })),
  );
  return run(extractions, { "go.mod": GO_MOD });
}

describe("go: local names shadow packages and functions", () => {
  it("a parameter named like an imported package does not call into the package", async () => {
    const { result } = await analyze({
      "store/store.go": "package store\nfunc Open() {}\n",
      "a/a.go": [
        "package a",
        'import "example.com/proj/store"',
        "type T struct{}",
        "func (T) M() {}",
        "func shadow(store *T) { store.Open() }",
        "func local() { store := T{}; store.M() }",
        "func real() { store.Open() }",
      ].join("\n"),
    });
    const calls = result.edges.filter((e) => e.kind === "calls");
    const dst = (from: string) =>
      calls.filter((e) => e.src === sym("a/a.go", from)).map((e) => e.dst);
    expect(dst("shadow")).not.toContain(sym("store/store.go", "Open"));
    expect(dst("local")).toContain(sym("a/a.go", "T.M"));
    expect(dst("real")).toContain(sym("store/store.go", "Open"));
  });

  it("a local function value does not call a package function of the same name", async () => {
    const { result } = await analyze({
      "app/main.go": [
        "package app",
        "func helper() {}",
        "func shadowFunc() { helper := func() {}; helper() }",
        "func shadowParam(helper func()) { helper() }",
        "func plain() { helper() }",
      ].join("\n"),
    });
    const calls = result.edges.filter((e) => e.kind === "calls");
    const target = sym("app/main.go", "helper");
    expect(calls.filter((e) => e.dst === target).map((e) => e.src)).toEqual([
      sym("app/main.go", "plain"),
    ]);
  });

  it("an unaliased third-party import with a different package name does not name-match", async () => {
    const { result } = await analyze({
      "pkg/c.go": [
        "package pkg",
        'import "github.com/hashicorp/golang-lru/v2"',
        "type Client struct{}",
        "func (c *Client) Add() {}",
        "func run() { lru.Add(1) }",
      ].join("\n"),
    });
    expect(result.edges.filter((e) => e.kind === "calls")).toEqual([]);
  });
});
