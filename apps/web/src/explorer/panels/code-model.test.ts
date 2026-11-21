import { describe, expect, it } from "vitest";
import type { GraphNode, SourceResponse } from "../../api/types.ts";
import {
  callSiteLineIn,
  computeTarget,
  githubUrlForSource,
  gutterWidth,
  isInSpan,
  looksBinary,
  MAX_LINES,
  rangeLabel,
  scrollTargetLine,
  truncationNotice,
} from "./code-model.ts";

const fn: GraphNode = {
  id: "sym:src/a.ts#run",
  kind: "function",
  name: "run",
  file: "src/a.ts",
  span: { startLine: 20, endLine: 30 },
};
const fileNode: GraphNode = { id: "file:src/a.ts", kind: "file", name: "a.ts", file: "src/a.ts" };

function source(over: Partial<SourceResponse> = {}): SourceResponse {
  return {
    file: "src/a.ts",
    language: "typescript",
    startLine: 15,
    endLine: 35,
    totalLines: 100,
    content: "x",
    ...over,
  };
}

describe("computeTarget", () => {
  it("adds 5 lines of context around a symbol and records the selected span", () => {
    expect(computeTarget(fn, undefined)).toEqual({
      file: "src/a.ts",
      start: 15,
      end: 35,
      selStart: 20,
      selEnd: 30,
      wholeFile: false,
    });
  });

  it("never starts before line 1", () => {
    const early = { ...fn, span: { startLine: 2, endLine: 4 } };
    expect(computeTarget(early, undefined)?.start).toBe(1);
  });

  it("loads the whole file (up to the cap) for a file node, ignoring its span", () => {
    const target = computeTarget({ ...fileNode, span: { startLine: 1, endLine: 5 } }, undefined);
    expect(target).toMatchObject({ start: 1, end: MAX_LINES, wholeFile: true });
    expect(target?.selStart).toBeUndefined();
  });

  it("has no target for nodes without a file", () => {
    expect(computeTarget({ id: "dir:src", kind: "directory", name: "src" }, undefined)).toBe(
      undefined,
    );
  });

  it("widens the range to include a call site in the same file only", () => {
    const same = computeTarget(fn, { file: "src/a.ts", line: 60 });
    expect(same).toMatchObject({ start: 15, end: 65 });
    const other = computeTarget(fn, { file: "src/other.ts", line: 60 });
    expect(other).toMatchObject({ start: 15, end: 35 });
  });

  it("moves the whole-file window when the call site is beyond the cap", () => {
    const target = computeTarget(fileNode, { file: "src/a.ts", line: 5000 });
    expect(target && target.start <= 5000 && 5000 <= target.end).toBe(true);
    expect(target ? target.end - target.start + 1 : 0).toBe(MAX_LINES);
  });
});

describe("call-site highlighting", () => {
  it("uses the call site only for the loaded file and inside the loaded lines", () => {
    const src = source();
    expect(callSiteLineIn({ file: "src/a.ts", line: 22 }, src)).toBe(22);
    expect(callSiteLineIn({ file: "src/a.ts", line: 99 }, src)).toBeUndefined();
    expect(callSiteLineIn({ file: "src/b.ts", line: 22 }, src)).toBeUndefined();
    expect(callSiteLineIn(undefined, src)).toBeUndefined();
  });

  it("scrolls to the call site, else to the selection start", () => {
    expect(scrollTargetLine(22, 20)).toBe(22);
    expect(scrollTargetLine(undefined, 20)).toBe(20);
    expect(scrollTargetLine(undefined, undefined)).toBeUndefined();
  });

  it("knows which lines belong to the selected span", () => {
    expect(isInSpan(20, 20, 30)).toBe(true);
    expect(isInSpan(31, 20, 30)).toBe(false);
    expect(isInSpan(5, undefined, undefined)).toBe(false);
  });
});

describe("notices and labels", () => {
  const whole = computeTarget(fileNode, undefined);

  it("warns when a whole-file view was cut short", () => {
    if (!whole) throw new Error("expected a target");
    const cut = source({ startLine: 1, endLine: 2000, totalLines: 5000 });
    expect(truncationNotice(cut, whole)).toContain("1–2000 of 5000");
    expect(truncationNotice(source({ startLine: 1, endLine: 40, totalLines: 40 }), whole)).toBe(
      undefined,
    );
  });

  it("does not warn for a symbol view", () => {
    const target = computeTarget(fn, undefined);
    if (!target) throw new Error("expected a target");
    expect(truncationNotice(source(), target)).toBeUndefined();
  });

  it("detects binary content and formats the range", () => {
    expect(looksBinary("a\0b")).toBe(true);
    expect(looksBinary("plain text")).toBe(false);
    expect(rangeLabel(source())).toBe("lines 15–35 of 100");
    expect(rangeLabel(source({ totalLines: 0, startLine: 0, endLine: 0 }))).toBe("empty file");
    expect(gutterWidth(5)).toBe(2);
    expect(gutterWidth(12345)).toBe(5);
  });
});

describe("githubUrlForSource", () => {
  const analysis = { owner: "acme", repo: "widgets", ref: "main", commitSha: "abc123" };

  it("pins to the commit and adds the line range", () => {
    expect(githubUrlForSource(analysis, "src/a b.ts", 20, 30)).toBe(
      "https://github.com/acme/widgets/blob/abc123/src/a%20b.ts#L20-L30",
    );
    expect(githubUrlForSource(analysis, "src/a.ts", 22, undefined)).toBe(
      "https://github.com/acme/widgets/blob/abc123/src/a.ts#L22",
    );
    expect(githubUrlForSource(analysis, "src/a.ts", undefined, undefined)).toBe(
      "https://github.com/acme/widgets/blob/abc123/src/a.ts",
    );
  });

  it("falls back to the ref without a commit", () => {
    expect(githubUrlForSource({ ...analysis, commitSha: null }, "a.ts", 1, 1)).toContain(
      "/blob/main/a.ts#L1",
    );
  });
});
