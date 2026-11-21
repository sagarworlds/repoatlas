import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  applyPatch,
  DEFAULT_PARAMS,
  decodeHighlight,
  encodeHighlight,
  parseExplorerParams,
  serializeExplorerParams,
  useExplorerParams,
} from "./url-state.ts";

const parse = (qs: string) => parseExplorerParams(new URLSearchParams(qs));

describe("parseExplorerParams", () => {
  it("returns the defaults for an empty query", () => {
    expect(parse("")).toEqual(DEFAULT_PARAMS);
  });

  it("falls back to defaults for unknown values", () => {
    const p = parse("tab=nope&level=x&conf=high&tests=yes&ext=2&dir=sideways&kinds=foo,bar");
    expect(p).toEqual(DEFAULT_PARAMS);
  });

  it("clamps numbers and ignores non-numeric ones", () => {
    expect(parse("depth=99").depth).toBe(5);
    expect(parse("depth=0").depth).toBe(1);
    expect(parse("up=9&down=-3")).toMatchObject({ up: 4, down: 0 });
    expect(parse("up=abc&down=1.5")).toMatchObject({ up: 1, down: 2 });
  });

  it("uses a tab specific depth range and default", () => {
    expect(parse("tab=deps").depth).toBe(1);
    expect(parse("tab=deps&depth=5").depth).toBe(3);
    expect(parse("tab=flow").depth).toBe(2);
  });

  it("keeps only valid edge kinds in canonical order, without contains", () => {
    expect(parse("kinds=calls,contains,imports,calls").kinds).toEqual(["imports", "calls"]);
    expect(parse("kinds=extends,imports").kinds).toEqual(["imports", "extends"]);
  });

  it("rejects values with control characters and malformed highlights", () => {
    expect(parse("node=a%00b").node).toBeUndefined();
    expect(parse("hl=src/a.ts").hl).toBeUndefined();
    expect(parse("hl=src/a.ts@0").hl).toBeUndefined();
    expect(parse("hl=src/a.ts@42").hl).toBe("src/a.ts@42");
  });
});

describe("serializeExplorerParams", () => {
  it("omits defaults", () => {
    expect(serializeExplorerParams(DEFAULT_PARAMS).toString()).toBe("");
  });

  it("round-trips a full state", () => {
    const state = parseExplorerParams(
      new URLSearchParams({
        tab: "flow",
        node: "sym:src/a.ts#run",
        file: "src/a.ts",
        root: "dir:src",
        level: "symbol",
        kinds: "imports,extends",
        conf: "inferred",
        tests: "1",
        ext: "1",
        depth: "4",
        up: "3",
        down: "0",
        dir: "imports",
        hl: "src/a.ts@42",
      }),
    );
    expect(state.node).toBe("sym:src/a.ts#run");
    const again = parseExplorerParams(serializeExplorerParams(state));
    expect(again).toEqual(state);
  });

  it("round-trips ids with special characters", () => {
    const state = { ...DEFAULT_PARAMS, node: "sym:src/a b.ts#Foo.bar&x=1", tab: "flow" as const };
    expect(parseExplorerParams(serializeExplorerParams(state))).toEqual(state);
  });

  it("writes depth only when it differs from the tab default", () => {
    expect(serializeExplorerParams({ ...DEFAULT_PARAMS, tab: "deps", depth: 1 }).get("depth")).toBe(
      null,
    );
    expect(serializeExplorerParams({ ...DEFAULT_PARAMS, tab: "deps", depth: 2 }).get("depth")).toBe(
      "2",
    );
    expect(serializeExplorerParams({ ...DEFAULT_PARAMS, depth: 1 }).get("depth")).toBe("1");
  });
});

describe("applyPatch", () => {
  it("resets depth when only the tab changes", () => {
    const current = { ...DEFAULT_PARAMS, depth: 4 };
    expect(applyPatch(current, { tab: "deps" }).depth).toBe(1);
    expect(applyPatch(current, { tab: "deps", depth: 2 }).depth).toBe(2);
  });

  it("clears optional values with undefined", () => {
    const current = { ...DEFAULT_PARAMS, node: "x" };
    expect(applyPatch(current, { node: undefined }).node).toBeUndefined();
  });

  it("clears a stale file and hl when the selected node changes", () => {
    const current = parseExplorerParams(new URLSearchParams("node=sym:a&file=a.ts&hl=a.ts@3"));
    const next = applyPatch(current, { node: "file:b.ts" });
    expect(next.file).toBeUndefined();
    expect(next.hl).toBeUndefined();
  });

  it("keeps file and hl when node is unchanged or they are set explicitly", () => {
    const current = parseExplorerParams(new URLSearchParams("node=sym:a&file=a.ts&hl=a.ts@3"));
    expect(applyPatch(current, { tab: "flow" }).file).toBe("a.ts");
    expect(applyPatch(current, { node: "sym:a" }).hl).toBe("a.ts@3");
    expect(applyPatch(current, { node: "file:b.ts", file: "b.ts" }).file).toBe("b.ts");
  });
});

describe("highlight helpers", () => {
  it("encodes and decodes path@line", () => {
    expect(encodeHighlight("src/a.ts", 42)).toBe("src/a.ts@42");
    expect(decodeHighlight("src/a@b.ts@7")).toEqual({ file: "src/a@b.ts", line: 7 });
    expect(decodeHighlight(undefined)).toBeUndefined();
  });
});

describe("useExplorerParams", () => {
  function setup(initial: string) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
    );
    return renderHook(
      () => {
        const state = useExplorerParams();
        const location = useLocation();
        return { ...state, search: location.search };
      },
      { wrapper },
    );
  }

  it("reads state from the URL and writes patches back", () => {
    const { result } = setup("/a/an_1?tab=flow&foo=bar");
    expect(result.current.params.tab).toBe("flow");
    act(() => result.current.setParams({ node: "sym:a" }, { push: true }));
    expect(result.current.params.node).toBe("sym:a");
    expect(result.current.search).toContain("node=sym%3Aa");
    expect(result.current.search).toContain("foo=bar"); // foreign params survive
  });

  it("removes a value that is reset to its default", () => {
    const { result } = setup("/a/an_1?tab=deps");
    act(() => result.current.setParams({ tab: "map" }));
    expect(result.current.search).toBe("");
  });
});
