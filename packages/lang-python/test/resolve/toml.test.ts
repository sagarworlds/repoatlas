import { describe, expect, it } from "vitest";
import { parseIni } from "../../src/prepare/ini.ts";
import { MAX_TOML_CHARS, parseToml } from "../../src/prepare/toml.ts";

describe("parseToml", () => {
  it("reads tables, dotted keys and nested headers", () => {
    const toml = parseToml(`
[project]
name = "shop"
version = '0.1.0'
count = 3
ratio = 1.5
flag = true

[tool.setuptools.packages.find]
where = ["src"]

[tool."odd key".sub]
a.b = 1
`);
    expect(toml).toEqual({
      project: { name: "shop", version: "0.1.0", count: 3, ratio: 1.5, flag: true },
      tool: {
        setuptools: { packages: { find: { where: ["src"] } } },
        "odd key": { sub: { a: { b: 1 } } },
      },
    });
  });

  it("reads multi-line arrays with comments and trailing commas", () => {
    const toml = parseToml(`
deps = [
  "a",   # first
  "b",
]
`);
    expect(toml.deps).toEqual(["a", "b"]);
  });

  it("reads inline tables and arrays of them", () => {
    const toml = parseToml(`
packages = [{ include = "x", from = "src" }, { include = "y" }]
`);
    expect(toml.packages).toEqual([{ include: "x", from: "src" }, { include: "y" }]);
  });

  it("reads arrays of tables and sub-tables of the last element", () => {
    const toml = parseToml(`
[[item]]
name = "a"
[item.opts]
x = 1
[[item]]
name = "b"
`);
    expect(toml.item).toEqual([{ name: "a", opts: { x: 1 } }, { name: "b" }]);
  });

  it("reads all four string kinds and escapes", () => {
    const toml = parseToml(
      [
        'a = "tab\\there \\u00e9"',
        "b = 'raw \\n stays'",
        'c = """',
        "first",
        "second \\",
        '   joined"""',
        "d = '''",
        "lit''' ",
      ].join("\n"),
    );
    expect(toml.a).toBe("tab\there é");
    expect(toml.b).toBe("raw \\n stays");
    expect(toml.c).toBe("first\nsecond joined");
    expect(toml.d).toBe("lit");
  });

  it("keeps dates and other bare values as raw strings", () => {
    const toml = parseToml("when = 1979-05-27T07:32:00Z\nhex = 0xFF");
    expect(toml.when).toBe("1979-05-27T07:32:00Z");
    expect(toml.hex).toBe("0xFF");
  });

  it("handles CRLF line endings", () => {
    expect(parseToml('[a]\r\nb = "c"\r\n')).toEqual({ a: { b: "c" } });
  });

  it("treats __proto__ as a normal key", () => {
    const toml = parseToml("[__proto__]\nx = 1");
    expect(Object.keys(toml)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  const malformed: [string, string][] = [
    ["unterminated string", 'a = "oops'],
    ["missing value", "a ="],
    ["missing equals", "a b"],
    ["unterminated array", "a = [1, 2"],
    ["unterminated inline table", "a = { b = 1"],
    ["duplicate key", "a = 1\na = 2"],
    ["duplicate table", "[a]\n[a]"],
    ["text after value", "a = 1 2"],
    ["bad escape", 'a = "\\q"'],
    ["bad unicode escape", 'a = "\\uZZZZ"'],
    ["newline in string", 'a = "x\ny"'],
    ["unclosed header", "[a"],
    ["key is not a table", "a = 1\n[a.b]"],
    ["garbage", "\u0000\u0001 = = ["],
  ];
  it.each(malformed)("returns an empty table for %s without throwing", (_name, text) => {
    expect(() => parseToml(text)).not.toThrow();
    expect(parseToml(text)).toEqual({});
  });

  it("returns an empty table for oversized input and runaway nesting", () => {
    expect(parseToml(`a = "${"x".repeat(MAX_TOML_CHARS)}"`)).toEqual({});
    expect(parseToml(`a = ${"[".repeat(5000)}${"]".repeat(5000)}`)).toEqual({});
  });
});

describe("parseIni", () => {
  it("reads sections, continuation lines and comments", () => {
    const ini = parseIni(`
# comment
[metadata]
name = shop

[options]
package_dir =
    =src
    other = lib/other
packages = find:

[Options.Packages.Find]
where = src
`);
    expect(ini.get("metadata")?.get("name")).toBe("shop");
    expect(ini.get("options")?.get("package_dir")).toBe("\n=src\nother = lib/other");
    expect(ini.get("options.packages.find")?.get("where")).toBe("src");
  });

  it("never throws on junk", () => {
    expect(parseIni("= = =\n[unclosed\n\u0000").size).toBe(0);
  });
});
