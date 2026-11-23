import { describe, expect, it } from "vitest";
import { externalKeyFor, packagePartOf } from "../../src/resolve/java-names.ts";
import { extraction, file, run, show } from "./helpers.ts";

const userFile = extraction("src/main/java/com/acme/model/User.java", {
  pkg: "com.acme.model",
  defs: { User: "class" },
});
const otherUser = extraction("src/main/java/com/other/User.java", {
  pkg: "com.other",
  defs: { User: "class" },
});

describe("imports", () => {
  it("resolves a single-type import by FQN to an exact file edge", async () => {
    const app = extraction("src/main/java/com/acme/App.java", {
      pkg: "com.acme",
      defs: { App: "class" },
      imports: [{ specifier: "com.acme.model.User", kind: "module", line: 3 }],
    });
    const { result } = await run([userFile, app]);
    expect(show(result.imports)).toEqual([`${file(app.file)} -> ${file(userFile.file)} (exact)`]);
    expect(result.imports[0]?.line).toBe(3);
    expect(result.imports[0]?.meta?.importedNames).toEqual(["User"]);
  });

  it("keeps same-named classes of two packages apart", async () => {
    const app = extraction("src/main/java/com/acme/App.java", {
      pkg: "com.acme",
      defs: { App: "class", "App.run": { kind: "method", params: 0 } },
      imports: [{ specifier: "com.other.User", kind: "module" }],
      refs: [
        { kind: "type", name: "User", fromLocalId: "App.run" },
        { kind: "instantiate", name: "User", fromLocalId: "App.run", argCount: 0 },
      ],
    });
    const { result } = await run([userFile, otherUser, app]);
    const dsts = result.edges.map((e) => e.dst);
    expect(dsts).toEqual([`sym:${otherUser.file}#User`, `sym:${otherUser.file}#User`]);
    expect(show(result.imports)).toEqual([`${file(app.file)} -> ${file(otherUser.file)} (exact)`]);
  });

  it("an import wins over a class of the same package", async () => {
    const samePackageUser = extraction("src/main/java/com/acme/User.java", {
      pkg: "com.acme",
      defs: { User: "class" },
    });
    const app = extraction("src/main/java/com/acme/App.java", {
      pkg: "com.acme",
      defs: { App: "class" },
      imports: [{ specifier: "com.other.User", kind: "module" }],
      refs: [{ kind: "type", name: "User", fromLocalId: "App" }],
    });
    const { result } = await run([samePackageUser, otherUser, app]);
    expect(result.edges.map((e) => e.dst)).toEqual([`sym:${otherUser.file}#User`]);
  });

  it("makes same-package classes visible without import", async () => {
    const helper = extraction("src/main/java/com/acme/Helper.java", {
      pkg: "com.acme",
      defs: { Helper: "class", "Helper.help": { kind: "method", params: 0, isStatic: true } },
    });
    const app = extraction("src/main/java/com/acme/App.java", {
      pkg: "com.acme",
      defs: { App: "class", "App.run": { kind: "method", params: 0 } },
      refs: [
        { kind: "call", name: "help", receiver: "Helper", argCount: 0, fromLocalId: "App.run" },
      ],
    });
    const { result, summary } = await run([helper, app]);
    expect(show(result.edges, "calls")).toEqual([
      `sym:${app.file}#App.run -> sym:${helper.file}#Helper.help (inferred)`,
    ]);
    expect(summary.unresolved).toBe(0);
  });

  it("resolves java.lang names implicitly and reports no unresolved", async () => {
    const app = extraction("App.java", {
      defs: { App: "class", "App.run": { kind: "method", params: 0 } },
      refs: [
        { kind: "type", name: "StringBuilder", fromLocalId: "App.run" },
        { kind: "call", name: "max", receiver: "Math", argCount: 2, fromLocalId: "App.run" },
        {
          kind: "call",
          name: "println",
          receiver: "System.out",
          argCount: 1,
          fromLocalId: "App.run",
        },
      ],
    });
    const { result } = await run([app]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.imports).toEqual([]);
  });

  it("reports an import of a missing class in a repo package as unresolved", async () => {
    const app = extraction("src/main/java/com/acme/App.java", {
      pkg: "com.acme",
      defs: { App: "class" },
      imports: [{ specifier: "com.acme.model.Missing", kind: "module", line: 2 }],
    });
    const { result } = await run([userFile, app]);
    expect(result.imports).toEqual([]);
    expect(result.unresolved).toEqual([
      { file: app.file, line: 2, name: "com.acme.model.Missing", kind: "import" },
    ]);
  });

  it("binds a wildcard import and adds an edge only for files that are used", async () => {
    const order = extraction("src/main/java/com/acme/model/Order.java", {
      pkg: "com.acme.model",
      defs: { Order: "class" },
    });
    const app = extraction("src/main/java/com/acme/App.java", {
      pkg: "com.acme",
      defs: { App: "class", "App.run": { kind: "method", params: 0 } },
      imports: [{ specifier: "com.acme.model", kind: "wildcard", line: 4 }],
      refs: [{ kind: "type", name: "Order", fromLocalId: "App.run" }],
    });
    const { result } = await run([userFile, order, app]);
    expect(show(result.imports)).toEqual([`${file(app.file)} -> ${file(order.file)} (inferred)`]);
    expect(result.imports[0]?.line).toBe(4);
    expect(show(result.edges, "references")).toEqual([
      `sym:${app.file}#App.run -> sym:${order.file}#Order (inferred)`,
    ]);
  });

  it("a wildcard import that is never used produces no edge", async () => {
    const app = extraction("src/main/java/com/acme/App.java", {
      pkg: "com.acme",
      defs: { App: "class" },
      imports: [{ specifier: "com.acme.model", kind: "wildcard" }],
    });
    const { result } = await run([userFile, app]);
    expect(result.imports).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("binds nested classes through a class wildcard import", async () => {
    const outer = extraction("com/acme/Outer.java", {
      pkg: "com.acme",
      defs: { Outer: "class", "Outer.Inner": "class" },
    });
    const app = extraction("com/app/App.java", {
      pkg: "com.app",
      defs: { App: "class" },
      imports: [{ specifier: "com.acme.Outer", kind: "wildcard" }],
      refs: [{ kind: "type", name: "Inner", fromLocalId: "App" }],
    });
    const { result } = await run([outer, app]);
    expect(show(result.edges)).toEqual([
      `sym:${app.file}#App -> sym:${outer.file}#Outer.Inner (inferred)`,
    ]);
    expect(show(result.imports)).toEqual([`${file(app.file)} -> ${file(outer.file)} (inferred)`]);
  });

  it("imports a nested class by its qualified name", async () => {
    const outer = extraction("com/acme/Outer.java", {
      pkg: "com.acme",
      defs: { Outer: "class", "Outer.Inner": "class" },
    });
    const app = extraction("com/app/App.java", {
      pkg: "com.app",
      defs: { App: "class" },
      imports: [{ specifier: "com.acme.Outer.Inner", kind: "module" }],
      refs: [{ kind: "type", name: "Inner", fromLocalId: "App" }],
    });
    const { result } = await run([outer, app]);
    expect(show(result.edges)).toEqual([
      `sym:${app.file}#App -> sym:${outer.file}#Outer.Inner (inferred)`,
    ]);
  });

  it("makes one imports edge per (file, external) with the packages listed", async () => {
    const app = extraction("App.java", {
      defs: { App: "class" },
      imports: [
        { specifier: "java.util.List", kind: "module", line: 1 },
        { specifier: "java.io", kind: "wildcard", line: 2 },
        { specifier: "javax.inject.Inject", kind: "module", line: 3 },
        {
          specifier: "org.springframework.web.bind.annotation.GetMapping",
          kind: "module",
          line: 4,
        },
        {
          specifier: "org.springframework.beans.factory.annotation.Autowired",
          kind: "module",
          line: 5,
        },
        { specifier: "com.github.acme.tool.Tool", kind: "module", line: 6 },
        { specifier: "org.apache.commons.lang3.StringUtils", kind: "module", line: 7 },
        { specifier: "com.google.common.collect.ImmutableList", kind: "module", line: 8 },
      ],
    });
    const { result } = await run([app]);
    const byDst = new Map(result.imports.map((e) => [e.dst, e]));
    expect([...byDst.keys()].sort()).toEqual([
      "ext:maven:com.github.acme",
      "ext:maven:com.google",
      "ext:maven:jdk",
      "ext:maven:org.apache.commons",
      "ext:maven:org.springframework",
    ]);
    expect(byDst.get("ext:maven:jdk")?.meta?.packages).toEqual([
      "java.io",
      "java.util",
      "javax.inject",
    ]);
    expect(byDst.get("ext:maven:jdk")?.line).toBe(1);
    expect(byDst.get("ext:maven:org.springframework")?.meta?.packages).toEqual([
      "org.springframework.beans.factory.annotation",
      "org.springframework.web.bind.annotation",
    ]);
    expect(result.externals.map((n) => n.id)).toEqual([...byDst.keys()].sort());
    expect(
      result.externals.every((n) => n.kind === "external" && n.meta?.ecosystem === "maven"),
    ).toBe(true);
    expect(result.unresolved).toEqual([]);
  });

  it("names externals after a declared Maven groupId when one matches", async () => {
    const app = extraction("App.java", {
      defs: { App: "class" },
      imports: [{ specifier: "com.fasterxml.jackson.databind.ObjectMapper", kind: "module" }],
    });
    const pom = `<project><dependencies><dependency><groupId>com.fasterxml.jackson.core</groupId></dependency></dependencies></project>`;
    const plain = await run([app]);
    expect(plain.result.imports[0]?.dst).toBe("ext:maven:com.fasterxml");
    const withPom = await run(
      [extraction("App.java", { defs: { App: "class" }, imports: app.imports })],
      {
        "pom.xml": pom.replace("jackson.core", "jackson.databind"),
      },
    );
    expect(withPom.result.imports[0]?.dst).toBe("ext:maven:com.fasterxml.jackson.databind");
  });

  it("static named import: edge to the class file, calls bind to the member", async () => {
    const strings = extraction("com/acme/Strings.java", {
      pkg: "com.acme",
      defs: { Strings: "class", "Strings.blank": { kind: "method", params: 1, isStatic: true } },
    });
    const app = extraction("com/app/App.java", {
      pkg: "com.app",
      defs: { App: "class", "App.run": { kind: "method", params: 0 } },
      imports: [{ specifier: "com.acme.Strings", kind: "named", names: [{ name: "blank" }] }],
      refs: [{ kind: "call", name: "blank", argCount: 1, fromLocalId: "App.run" }],
    });
    const { result } = await run([strings, app]);
    expect(show(result.imports)).toEqual([`${file(app.file)} -> ${file(strings.file)} (exact)`]);
    expect(show(result.edges)).toEqual([
      `sym:${app.file}#App.run -> sym:${strings.file}#Strings.blank (inferred)`,
    ]);
  });

  it("static on-demand import: calls bind, and the wildcard counts as used", async () => {
    const strings = extraction("com/acme/Strings.java", {
      pkg: "com.acme",
      defs: { Strings: "class", "Strings.blank": { kind: "method", params: 1, isStatic: true } },
    });
    const app = extraction("com/app/App.java", {
      pkg: "com.app",
      defs: { App: "class", "App.run": { kind: "method", params: 0 } },
      imports: [{ specifier: "com.acme.Strings", kind: "wildcard", line: 7 }],
      refs: [{ kind: "call", name: "blank", argCount: 1, fromLocalId: "App.run" }],
    });
    const { result } = await run([strings, app]);
    expect(show(result.edges)).toEqual([
      `sym:${app.file}#App.run -> sym:${strings.file}#Strings.blank (inferred)`,
    ]);
    expect(show(result.imports)).toEqual([`${file(app.file)} -> ${file(strings.file)} (inferred)`]);
    expect(result.imports[0]?.line).toBe(7);
  });

  it("external static imports make no edge and no unresolved call", async () => {
    const app = extraction("App.java", {
      defs: { App: "class", "App.run": { kind: "method", params: 0 } },
      imports: [
        { specifier: "org.junit.Assert", kind: "named", names: [{ name: "assertEquals" }] },
        { specifier: "org.mockito.Mockito", kind: "wildcard" },
      ],
      refs: [
        { kind: "call", name: "assertEquals", argCount: 2, fromLocalId: "App.run" },
        { kind: "call", name: "mock", argCount: 1, fromLocalId: "App.run" },
      ],
    });
    const { result } = await run([app]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.imports.map((e) => e.dst).sort()).toEqual([
      "ext:maven:org.junit",
      "ext:maven:org.mockito",
    ]);
  });
});

describe("java-names", () => {
  it("packagePartOf keeps the leading lower case segments", () => {
    expect(packagePartOf("java.util.Map.Entry")).toBe("java.util");
    expect(packagePartOf("Foo")).toBe("");
  });

  it("externalKeyFor applies the documented prefix rules", () => {
    expect(externalKeyFor("java.util")).toBe("jdk");
    expect(externalKeyFor("javax.servlet.http")).toBe("jdk");
    expect(externalKeyFor("com.sun.net.httpserver")).toBe("jdk");
    expect(externalKeyFor("org.w3c.dom")).toBe("jdk");
    expect(externalKeyFor("org.springframework.boot.autoconfigure")).toBe("org.springframework");
    expect(externalKeyFor("io.netty.buffer")).toBe("io.netty");
    expect(externalKeyFor("com.github.javaparser.ast")).toBe("com.github.javaparser");
    expect(externalKeyFor("com.google.cloud.storage")).toBe("com.google.cloud");
    expect(externalKeyFor("org.apache.commons.io")).toBe("org.apache.commons");
    expect(externalKeyFor("lombok")).toBe("lombok");
    expect(externalKeyFor("")).toBeUndefined();
  });
});
