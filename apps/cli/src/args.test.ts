import { describe, expect, it } from "vitest";
import { expandShorthand, parseCliArgs } from "./args.ts";

describe("parseCliArgs", () => {
  it("parses a url with --ref and --out", () => {
    expect(parseCliArgs(["https://github.com/a/b", "--ref", "main", "--out", "g.json"])).toEqual({
      kind: "analyze",
      target: "https://github.com/a/b",
      ref: "main",
      out: "g.json",
      local: undefined,
    });
  });

  it("accepts --local without a positional", () => {
    expect(parseCliArgs(["--local", "some/dir"])).toMatchObject({
      kind: "analyze",
      target: undefined,
      local: "some/dir",
    });
  });

  it("returns help for --help and -h", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
  });

  it.each([
    [[], "Missing"],
    [["a/b", "c/d"], "Only one"],
    [["a/b", "--local", "x"], "not both"],
    [["--local", "x", "--ref", "main"], "--ref"],
    [["a/b", "--bogus"], "bogus"],
    [["a/b", "--ref"], "ref"],
    [["a/b", "--out", ""], "empty"],
  ])("rejects %j", (argv, fragment) => {
    const result = parseCliArgs(argv);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain(fragment);
  });
});

describe("expandShorthand", () => {
  it("expands owner/repo and leaves urls alone", () => {
    expect(expandShorthand("sindresorhus/ky")).toBe("https://github.com/sindresorhus/ky");
    expect(expandShorthand("https://github.com/a/b")).toBe("https://github.com/a/b");
    expect(expandShorthand("a/b/c")).toBe("a/b/c");
  });
});
