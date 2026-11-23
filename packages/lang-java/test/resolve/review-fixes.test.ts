import type { GraphEdge } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { extractJava } from "../../src/extract/index.ts";
import { run } from "./helpers.ts";

async function analyze(files: Record<string, string>) {
  const extractions = [];
  for (const [path, content] of Object.entries(files)) {
    extractions.push(await extractJava({ path, content }));
  }
  return run(extractions);
}

function calls(edges: GraphEdge[]): string[] {
  return edges
    .filter((e) => e.kind === "calls")
    .map((e) => `${e.src.split("#")[1]} -> ${e.dst.split("#")[1]} (${e.confidence})`)
    .sort();
}

describe("java review fixes", () => {
  it("prefers the class of the caller's own module when several modules declare it", async () => {
    const { result } = await analyze({
      "mod-a/src/main/java/com/x/Util.java":
        "package com.x; public class Util { public static void a() {} public static void common() {} }",
      "mod-b/src/main/java/com/x/Util.java":
        "package com.x; public class Util { public static void b() {} public static void common() {} }",
      "mod-b/src/main/java/com/x/Use.java":
        "package com.x; public class Use { void m() { Util.common(); Util.b(); } }",
    });
    const targets = result.edges.filter((e) => e.kind === "calls").map((e) => e.dst);
    expect(targets.every((t) => t.startsWith("sym:mod-b/"))).toBe(true);
    expect(targets).toHaveLength(2);
    expect(result.unresolved).toEqual([]);
  });

  it("resolves static calls on all-caps class names", async () => {
    const { result } = await analyze({
      "a/DB.java": "package a; public class DB { public static void connect() {} }",
      "a/Cache.java": "package a; public class Cache { public static void connect() {} }",
      "a/Use.java": "package a; class Use { void t() { DB.connect(); } }",
    });
    expect(calls(result.edges)).toEqual(["Use.t -> DB.connect (inferred)"]);
  });

  it("does not name-match a receiver whose declared type is outside the repository", async () => {
    const { result } = await analyze({
      "a/Mine.java": "package a; public class Mine { public void process() {} }",
      "a/Use.java":
        "package a; import org.springframework.web.*; class Use { void t(Widget w) { w.process(); } void u(Missing m) { m.process(); } }",
    });
    expect(calls(result.edges)).toEqual([]);
  });

  it("types fields inherited from a repository super class", async () => {
    const { result } = await analyze({
      "a/Svc.java": "package a; public class Svc { public void execute() {} }",
      "a/Other.java": "package a; public class Other { public void execute() {} }",
      "a/Base.java": "package a; public class Base { protected Svc svc; }",
      "a/Child.java":
        "package a; public class Child extends Base { void t() { svc.execute(); this.svc.execute(); } }",
    });
    expect([...new Set(calls(result.edges))]).toEqual(["Child.t -> Svc.execute (inferred)"]);
  });

  it("binds an unqualified call in an inner class to its external super class first", async () => {
    const { result } = await analyze({
      "A.java":
        'class Outer { void add(String s) {} class Inner extends java.util.ArrayList<String> { void go() { add("x"); } } }',
    });
    expect(calls(result.edges)).toEqual([]);
  });

  it("references a repository class named like a java.lang type", async () => {
    const { result } = await analyze({
      "m/System.java": "package m; public class System { public void boot() {} }",
      "m/UseSys.java": "package m; class UseSys { System s; }",
    });
    const refs = result.edges.filter((e) => e.kind === "references");
    expect(refs.map((e) => e.dst)).toContain("sym:m/System.java#System");
  });
});
