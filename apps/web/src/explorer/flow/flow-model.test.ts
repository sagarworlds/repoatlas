import { describe, expect, it } from "vitest";
import type { CallflowResponse, GraphEdge, GraphNode } from "../../api/types.ts";
import {
  buildCallTree,
  buildFlowElements,
  describeFlowEdge,
  edgeById,
  edgeToSelection,
  flowLabel,
  isCallable,
  isFlowEmpty,
  truncateText,
} from "./flow-model.ts";

function fn(name: string, file = "src/a.ts", extra: Partial<GraphNode> = {}): GraphNode {
  return { id: `sym:${file}#${name}`, kind: "function", name, file, ...extra };
}
function call(src: GraphNode, dst: GraphNode, extra: Partial<GraphEdge> = {}): GraphEdge {
  return { src: src.id, dst: dst.id, kind: "calls", confidence: "exact", ...extra };
}

const main = fn("main", "src/main.ts");
const helper = fn("helper", "src/util.ts");
const leaf = fn("leaf", "src/leaf.ts");

describe("truncateText / flowLabel", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(truncateText("a  b\n c", 20)).toBe("a b c");
    expect(truncateText("abcdefghij", 5)).toBe("abcd…");
  });

  it("uses the name alone without a signature", () => {
    expect(flowLabel(main)).toBe("main");
  });

  it("drops the name prefix from the signature and truncates it", () => {
    const node = fn("run", "src/a.ts", { signature: `run(${"x: string, ".repeat(20)})` });
    const [line1, line2] = flowLabel(node).split("\n");
    expect(line1).toBe("run");
    expect(line2?.startsWith("(x: string")).toBe(true);
    expect(line2?.endsWith("…")).toBe(true);
    expect(line2?.length).toBeLessThanOrEqual(56);
  });
});

describe("isCallable", () => {
  it("accepts functions and methods only", () => {
    expect(isCallable({ kind: "function" })).toBe(true);
    expect(isCallable({ kind: "method" })).toBe(true);
    expect(isCallable({ kind: "class" })).toBe(false);
    expect(isCallable({ kind: "file" })).toBe(false);
  });
});

describe("buildFlowElements", () => {
  it("marks the focus, numbers edges and drops edges to unknown nodes", () => {
    const data: CallflowResponse = {
      focus: main.id,
      nodes: [main, helper],
      edges: [
        call(main, helper, { line: 7, meta: { callCount: 3 } }),
        call(main, leaf, { line: 9 }),
      ],
    };
    const els = buildFlowElements(data);
    expect(els.nodes.map((n) => n.data.isFocus)).toEqual([true, false]);
    expect(els.edges).toHaveLength(1);
    expect(els.edges[0]?.data).toMatchObject({
      id: "e0",
      source: main.id,
      target: helper.id,
      line: 7,
      callCount: 3,
      confidence: "exact",
    });
  });

  it("keeps the original edge index in ids so edgeById stays consistent", () => {
    const data: CallflowResponse = {
      focus: main.id,
      nodes: [main, helper],
      edges: [call(main, leaf), call(main, helper, { line: 2 })],
    };
    const els = buildFlowElements(data);
    expect(els.edges[0]?.data.id).toBe("e1");
    expect(edgeById(data, "e1")?.dst).toBe(helper.id);
    expect(edgeById(data, "nope")).toBeUndefined();
    expect(edgeById(data, "e9")).toBeUndefined();
  });
});

describe("edgeToSelection", () => {
  const nodes = new Map([main, helper].map((n) => [n.id, n]));

  it("selects the caller and highlights path@line", () => {
    expect(edgeToSelection(call(main, helper, { line: 12 }), nodes)).toEqual({
      callerId: main.id,
      hl: "src/main.ts@12",
    });
  });

  it("uses the path of a file node as the caller file", () => {
    const fileNode: GraphNode = { id: "file:src/x.ts", kind: "file", name: "x.ts" };
    const edge = call(fileNode, helper, { line: 3 });
    expect(edgeToSelection(edge, new Map([[fileNode.id, fileNode]]))?.hl).toBe("src/x.ts@3");
  });

  it("returns undefined without a call-site line or a known caller", () => {
    expect(edgeToSelection(call(main, helper), nodes)).toBeUndefined();
    expect(edgeToSelection(call(leaf, helper, { line: 1 }), nodes)).toBeUndefined();
  });
});

describe("describeFlowEdge", () => {
  it("describes a single line, multiple lines and call counts", () => {
    expect(describeFlowEdge(call(main, helper, { line: 4 }), main)).toBe(
      "Call at src/main.ts, line 4 · exact",
    );
    const many = call(main, helper, { meta: { lines: [1, 2, 3], callCount: 3 } });
    expect(describeFlowEdge(many, main)).toContain("lines 1, 2, 3");
    expect(describeFlowEdge(many, main)).toContain("3 calls");
    expect(describeFlowEdge(call(main, helper), undefined)).toContain("line unknown");
  });
});

describe("buildCallTree", () => {
  it("nests callees and callers and marks repeats (cycles stay finite)", () => {
    const data: CallflowResponse = {
      focus: main.id,
      nodes: [main, helper, leaf],
      edges: [
        call(main, helper),
        call(helper, leaf),
        call(leaf, main), // cycle back to the focus
        call(main, leaf), // diamond
      ],
    };
    const callees = buildCallTree(data, "callees");
    expect(callees.map((i) => i.node.name)).toEqual(["helper", "leaf"]);
    expect(callees[0]?.children.map((i) => i.node.name)).toEqual(["leaf"]);
    expect(callees[0]?.children[0]?.repeated).toBe(false);
    expect(callees[1]?.repeated).toBe(true);

    const callers = buildCallTree(data, "callers");
    expect(callers.map((i) => i.node.name)).toEqual(["leaf"]);
    expect(callers[0]?.children.map((i) => i.node.name)).toEqual(["helper", "main"]);
    expect(callers[0]?.children[1]?.repeated).toBe(true);
  });
});

describe("isFlowEmpty", () => {
  it("is true when there are no edges", () => {
    expect(isFlowEmpty({ focus: main.id, nodes: [main], edges: [] })).toBe(true);
    expect(
      isFlowEmpty({ focus: main.id, nodes: [main, helper], edges: [call(main, helper)] }),
    ).toBe(false);
  });
});
