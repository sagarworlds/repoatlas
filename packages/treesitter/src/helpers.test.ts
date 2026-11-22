import { describe, expect, it } from "vitest";
import { buildDefinitions, type DefinitionCandidate } from "./definitions.ts";
import {
  buildLineIndex,
  classifyReceiver,
  collapseWhitespace,
  comparePositions,
  findEnclosingRanges,
  positionAt,
  spanContains,
  stripQuotes,
  toSpan,
  truncateSignature,
} from "./helpers.ts";

const scopes = { selfNames: ["self", "cls"], superNames: ["super"] };

describe("toSpan", () => {
  it("is 1-based inclusive", () => {
    expect(toSpan(0, 4, 3)).toEqual({ startLine: 1, endLine: 5 });
  });
  it("does not count a trailing newline row", () => {
    expect(toSpan(2, 6, 0)).toEqual({ startLine: 3, endLine: 6 });
  });
  it("keeps a single-line node at column 0 of the same row", () => {
    expect(toSpan(2, 2, 0)).toEqual({ startLine: 3, endLine: 3 });
  });
});

describe("spanContains", () => {
  it("handles nesting and overlap", () => {
    expect(spanContains({ startLine: 1, endLine: 10 }, { startLine: 2, endLine: 3 })).toBe(true);
    expect(spanContains({ startLine: 2, endLine: 3 }, { startLine: 1, endLine: 10 })).toBe(false);
    expect(spanContains({ startLine: 1, endLine: 5 }, { startLine: 4, endLine: 6 })).toBe(false);
  });
});

describe("line index", () => {
  const src = "ab\ncde\n\nf";
  const index = buildLineIndex(src);
  it("finds line and column", () => {
    expect(index).toEqual([0, 3, 7, 8]);
    expect(positionAt(index, 0)).toEqual({ line: 1, column: 0 });
    expect(positionAt(index, 4)).toEqual({ line: 2, column: 1 });
    expect(positionAt(index, 7)).toEqual({ line: 3, column: 0 });
    expect(positionAt(index, 8)).toEqual({ line: 4, column: 0 });
  });
});

describe("text helpers", () => {
  it("collapses whitespace", () => {
    expect(collapseWhitespace("  def f(\n    a,\n  b)  ")).toBe("def f( a, b)");
  });
  it("truncates to the limit with an ellipsis", () => {
    const out = truncateSignature("x".repeat(500));
    expect(out).toHaveLength(300);
    expect(out.endsWith("…")).toBe(true);
    expect(truncateSignature("short  one")).toBe("short one");
  });
  it("strips one pair of matching quotes only", () => {
    expect(stripQuotes('"./a"')).toBe("./a");
    expect(stripQuotes("'x'")).toBe("x");
    expect(stripQuotes("`x`")).toBe("x");
    expect(stripQuotes("'x\"")).toBe("'x\"");
    expect(stripQuotes("a.b")).toBe("a.b");
    expect(stripQuotes('"')).toBe('"');
  });
});

describe("classifyReceiver", () => {
  it.each([
    ["self", "identifier", "self"],
    ["cls", "identifier", "self"],
    ["super", "identifier", "super"],
    ["super()", "call", "super"],
    ["super(Foo, self)", "call", "super"],
    ["utils", "identifier", "identifier"],
    ["np", undefined, "identifier"],
    ["self.repo", "attribute", "member-chain"],
    ["a.b.c", "attribute", "member-chain"],
    ["a::b", undefined, "member-chain"],
    ["get_user()", "call", "call"],
    ["repo.find(1)", "call", "call"],
    ['"abc"', "string", "other"],
    ["items[0]", "subscript", "other"],
    ["", undefined, "other"],
  ] as const)("%s (%s) is %s", (text, nodeType, expected) => {
    expect(classifyReceiver(text, nodeType, scopes)).toBe(expected);
  });

  it("falls back to the node type for call-like nodes", () => {
    expect(classifyReceiver("new Foo", "call_expression", scopes)).toBe("call");
  });
});

describe("findEnclosingRanges", () => {
  const ranges = [
    { startIndex: 0, endIndex: 100 }, // 0 outer
    { startIndex: 10, endIndex: 50 }, // 1 inner
    { startIndex: 60, endIndex: 90 }, // 2 sibling
    { startIndex: 200, endIndex: 300 }, // 3 later
  ];
  it("picks the innermost containing range", () => {
    expect(findEnclosingRanges(ranges, [20, 55, 70, 150, 250, 100, 0])).toEqual([
      1, 0, 2, -1, 3, -1, 0,
    ]);
  });
  it("returns -1 for everything with no ranges", () => {
    expect(findEnclosingRanges([], [1, 2])).toEqual([-1, -1]);
  });
  it("is independent of input order", () => {
    const shuffled = [ranges[3], ranges[1], ranges[0], ranges[2]] as typeof ranges;
    expect(findEnclosingRanges(shuffled, [20, 250])).toEqual([1, 0]);
  });
});

describe("comparePositions", () => {
  it("orders by line, column, name", () => {
    const items = [
      { line: 2, column: 0, name: "b" },
      { line: 1, column: 5, name: "z" },
      { line: 1, column: 5, name: "a" },
      { line: 1, column: 1, name: "q" },
    ];
    expect(items.sort(comparePositions).map((i) => i.name)).toEqual(["q", "a", "z", "b"]);
  });
});

function cand(
  name: string,
  kind: DefinitionCandidate["kind"],
  nodeType: string,
  startIndex: number,
  endIndex: number,
  startLine = startIndex,
): DefinitionCandidate {
  return { name, kind, nodeType, startIndex, endIndex, startLine, endLine: startLine + 1 };
}

describe("buildDefinitions (plain data)", () => {
  const containers = ["class_definition"];

  it("builds dotted ids, methods and parents", () => {
    const built = buildDefinitions(
      [
        cand("inner", "function", "function_definition", 30, 40),
        cand("User", "class", "class_definition", 0, 100),
        cand("save", "function", "function_definition", 20, 60),
        cand("helper", "function", "function_definition", 120, 150),
      ],
      containers,
    ).map((b) => b.definition);
    expect(built.map((d) => [d.localId, d.kind, d.parentLocalId])).toEqual([
      ["User", "class", undefined],
      ["User.save", "method", "User"],
      ["User.save.inner", "function", "User.save"],
      ["helper", "function", undefined],
    ]);
  });

  it("disambiguates collisions and lets children follow the renamed parent", () => {
    const built = buildDefinitions(
      [
        cand("f", "function", "function_definition", 0, 10, 1),
        cand("f", "function", "function_definition", 20, 50, 5),
        cand("g", "function", "function_definition", 25, 30, 6),
      ],
      containers,
    ).map((b) => b.definition.localId);
    expect(built).toEqual(["f", "f@5", "f@5.g"]);
  });

  it("returns candidate indexes of the input array", () => {
    const built = buildDefinitions(
      [
        cand("b", "class", "class_definition", 50, 60),
        cand("a", "class", "class_definition", 0, 10),
      ],
      containers,
    );
    expect(built.map((b) => b.candidateIndex)).toEqual([1, 0]);
  });

  it("keeps an explicit method kind and ignores partial overlaps as siblings", () => {
    const built = buildDefinitions(
      [cand("m", "method", "func", 0, 10), cand("x", "function", "func", 5, 20)],
      containers,
    ).map((b) => [b.definition.localId, b.definition.kind]);
    expect(built).toEqual([
      ["m", "method"],
      ["x", "function"],
    ]);
  });
});
