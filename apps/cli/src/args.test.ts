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
      noCache: false,
    });
  });

  it("parses --no-cache", () => {
    expect(parseCliArgs(["--local", "d", "--no-cache"])).toMatchObject({ noCache: true });
  });

  it("parses --workers (0 = main thread only) and rejects bad values", () => {
    expect(parseCliArgs(["--local", "d"])).toMatchObject({ workers: undefined });
    expect(parseCliArgs(["--local", "d", "--workers", "4"])).toMatchObject({ workers: 4 });
    expect(parseCliArgs(["--local", "d", "--workers", "0"])).toMatchObject({ workers: 0 });
    for (const bad of ["-1", "2x", "1.5", "", "65", "many"]) {
      expect(parseCliArgs(["--local", "d", "--workers", bad]).kind).toBe("error");
    }
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
