import { describe, expect, it } from "vitest";
import { highlightCode, plainLines, shikiLanguageFor, toCodeLines } from "./shiki.ts";

describe("shikiLanguageFor", () => {
  it("maps every supported language id and rejects unknown ones", () => {
    for (const id of ["typescript", "python", "go", "csharp", "cpp", "ruby"]) {
      expect(shikiLanguageFor(id)).toBe(id);
    }
    expect(shikiLanguageFor("cobol")).toBeUndefined();
    expect(shikiLanguageFor("toString")).toBeUndefined(); // not an inherited object property
    expect(shikiLanguageFor(null)).toBeUndefined();
    expect(shikiLanguageFor(undefined)).toBeUndefined();
  });
});

describe("token grouping", () => {
  it("keeps one token list per line and converts font style flags", () => {
    const lines = toCodeLines([
      [{ content: "const", color: "#d73a49", fontStyle: 3 }, { content: " x" }],
      [],
    ]);
    expect(lines).toEqual([
      [{ text: "const", color: "#d73a49", italic: true, bold: true }, { text: " x" }],
      [],
    ]);
  });

  it("splits plain text into lines and keeps empty lines empty", () => {
    expect(plainLines("a\n\nb")).toEqual([[{ text: "a" }], [], [{ text: "b" }]]);
  });
});

describe("highlightCode", () => {
  it("returns plain lines for unknown languages without loading Shiki", async () => {
    expect(await highlightCode("a\nb", "cobol", "light")).toEqual(plainLines("a\nb"));
    expect(await highlightCode("a", null, "dark")).toEqual(plainLines("a"));
  });

  it("colours TypeScript tokens and keeps the text intact", async () => {
    const code = "const answer: number = 42;\n\nexport function f() {}";
    const lines = await highlightCode(code, "typescript", "light");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.map((t) => t.text).join("")).join("\n")).toBe(code);
    expect(lines[0]?.some((token) => token.color !== undefined)).toBe(true);
  }, 30_000);

  it("uses different colours for the dark theme", async () => {
    const light = await highlightCode("const a = 1;", "typescript", "light");
    const dark = await highlightCode("const a = 1;", "typescript", "dark");
    expect(dark[0]?.[0]?.color).not.toBe(light[0]?.[0]?.color);
  }, 30_000);
});
