import { describe, expect, it } from "vitest";
import type { MapEdge as ApiEdge, GraphResponse } from "../../api/types.ts";
import { buildBreadcrumb } from "./breadcrumb.ts";
import { pngFilename } from "./download.ts";
import {
  buildMapGraph,
  EDGE_LABEL_LIMIT,
  edgeWidth,
  isExpandable,
  MAX_RENDER_NODES,
  mergeGraphResponses,
  nodeSize,
  pathOfId,
  showEdgeLabels,
  topDegreeIds,
  topLevelGroup,
} from "./graph-model.ts";
import { DRAFT_QUALITY_THRESHOLD, fcoseOptions } from "./layout-options.ts";
import {
  arrowShape,
  borderStyle,
  buildStylesheet,
  edgeColor,
  edgeLook,
  mixHex,
  nodeShape,
} from "./map-style.ts";
import { themeFromReader } from "./map-theme.ts";
import { groupColor, hashString, paletteIndex } from "./palette.ts";

function dir(path: string, extra: Partial<GraphResponse["nodes"][number]> = {}) {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return {
    id: `dir:${path}`,
    kind: "directory" as const,
    name: path.split("/").pop() ?? "",
    parentId: path === "" ? undefined : `dir:${parent}`,
    ...extra,
  };
}
function imp(src: string, dst: string, weight?: number): ApiEdge {
  return {
    src,
    dst,
    kind: "imports",
    confidence: "exact",
    ...(weight !== undefined ? { weight } : {}),
  };
}

describe("buildMapGraph", () => {
  it("builds compound parents, parent-first, with edges", () => {
    const response: GraphResponse = {
      nodes: [dir("src/a"), dir("src"), dir("")],
      edges: [imp("dir:src/a", "dir:src", 3)],
      truncated: false,
    };
    const { graph, truncated } = buildMapGraph(response);
    expect(truncated).toBe(false);
    expect(graph.nodes.map((n) => n.id)).toEqual(["dir:", "dir:src", "dir:src/a"]);
    expect(graph.nodes.find((n) => n.id === "dir:src/a")?.parent).toBe("dir:src");
    expect(graph.nodes.find((n) => n.id === "dir:")?.parent).toBeUndefined();
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.label).toBe("3");
    expect(graph.edges[0]?.width).toBeGreaterThan(1);
  });

  it("treats a parent that is not in the set as top level (orphan)", () => {
    const { graph } = buildMapGraph({ nodes: [dir("src/deep/x")], edges: [], truncated: false });
    expect(graph.nodes[0]?.parent).toBeUndefined();
  });

  it("survives parent cycles and self parents (every parent chain ends)", () => {
    const a = { id: "dir:a", kind: "directory" as const, name: "a", parentId: "dir:b" };
    const b = { id: "dir:b", kind: "directory" as const, name: "b", parentId: "dir:a" };
    const c = { id: "dir:c", kind: "directory" as const, name: "c", parentId: "dir:c" };
    const { graph } = buildMapGraph({ nodes: [a, b, c], edges: [], truncated: false });
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes.find((n) => n.id === "dir:c")?.parent).toBeUndefined();
    const parentOf = new Map(graph.nodes.map((n) => [n.id, n.parent]));
    for (const n of graph.nodes) {
      let current = n.parent;
      let hops = 0;
      while (current !== undefined && hops++ < 10) current = parentOf.get(current);
      expect(current).toBeUndefined();
    }
  });

  it("drops duplicates, contains edges, self loops and dangling edges", () => {
    const response: GraphResponse = {
      nodes: [dir("a"), dir("a"), dir("b")],
      edges: [
        imp("dir:a", "dir:b"),
        imp("dir:a", "dir:b", 5),
        imp("dir:a", "dir:a"),
        imp("dir:a", "dir:missing"),
        { src: "dir:a", dst: "dir:b", kind: "contains", confidence: "exact" },
      ],
      truncated: false,
    };
    const { graph } = buildMapGraph(response);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.weight).toBe(5);
  });

  it("computes degree from the visible edges or the API meta, whichever is larger", () => {
    const response: GraphResponse = {
      nodes: [dir("a", { meta: { degree: 9 } }), dir("b"), dir("c")],
      edges: [imp("dir:b", "dir:c")],
      truncated: false,
    };
    const { graph } = buildMapGraph(response);
    const degree = (id: string) => graph.nodes.find((n) => n.id === id)?.degree;
    expect(degree("dir:a")).toBe(9);
    expect(degree("dir:b")).toBe(1);
  });

  it("caps the node count, keeps shallow connected nodes and reports truncation", () => {
    const nodes = [dir("")];
    for (let i = 0; i < 10; i++) nodes.push(dir(`d${i}`));
    const edges = [imp("dir:d9", "dir:d8")];
    const built = buildMapGraph({ nodes, edges, truncated: false }, 4);
    expect(built.graph.nodes).toHaveLength(4);
    expect(built.droppedByCap).toBe(7);
    expect(built.truncated).toBe(true);
    const ids = built.graph.nodes.map((n) => n.id);
    expect(ids).toContain("dir:");
    expect(ids).toContain("dir:d9");
    // No edge may point at a removed node.
    for (const e of built.graph.edges) {
      expect(ids).toContain(e.source);
      expect(ids).toContain(e.target);
    }
  });

  it("passes the API truncated flag through and uses a 2000 node default cap", () => {
    expect(MAX_RENDER_NODES).toBe(2000);
    const many = Array.from({ length: 2100 }, (_, i) => dir(`d${i}`));
    const built = buildMapGraph({ nodes: many, edges: [], truncated: false });
    expect(built.graph.nodes).toHaveLength(2000);
    expect(built.droppedByCap).toBe(100);
    expect(buildMapGraph({ nodes: [dir("a")], edges: [], truncated: true }).truncated).toBe(true);
  });

  it("is deterministic regardless of input order", () => {
    const nodes = [dir("b"), dir("a"), dir("c")];
    const one = buildMapGraph({ nodes, edges: [], truncated: false }).graph.nodes.map((n) => n.id);
    const two = buildMapGraph({
      nodes: [...nodes].reverse(),
      edges: [],
      truncated: false,
    }).graph.nodes.map((n) => n.id);
    expect(one).toEqual(two);
  });
});

describe("mergeGraphResponses (expand)", () => {
  const base: GraphResponse = {
    nodes: [dir(""), dir("src")],
    edges: [imp("dir:src", "dir:", 2)],
    truncated: false,
  };

  it("adds new nodes and edges without duplicates", () => {
    const extra: GraphResponse = {
      nodes: [dir("src"), dir("src/a")],
      edges: [imp("dir:src", "dir:", 2), imp("dir:src/a", "dir:src")],
      truncated: true,
    };
    const merged = mergeGraphResponses(base, extra);
    expect(merged.nodes.map((n) => n.id)).toEqual(["dir:", "dir:src", "dir:src/a"]);
    expect(merged.edges).toHaveLength(2);
    expect(merged.truncated).toBe(true);
  });

  it("is idempotent and keeps the larger weight", () => {
    const once = mergeGraphResponses(base, base);
    expect(once.nodes).toHaveLength(2);
    expect(once.edges).toHaveLength(1);
    const heavier = mergeGraphResponses(base, { ...base, edges: [imp("dir:src", "dir:", 7)] });
    expect(heavier.edges[0]?.weight).toBe(7);
  });

  it("gives a child its compound parent after the merge", () => {
    const merged = mergeGraphResponses(base, {
      nodes: [dir("src/a")],
      edges: [],
      truncated: false,
    });
    const { graph } = buildMapGraph(merged);
    expect(graph.nodes.find((n) => n.id === "dir:src/a")?.parent).toBe("dir:src");
  });
});

describe("scaling and metrics", () => {
  it("node size grows with log(degree) and is clamped", () => {
    expect(nodeSize(0, "directory")).toBeGreaterThanOrEqual(12);
    expect(nodeSize(10, "directory")).toBeGreaterThan(nodeSize(1, "directory"));
    expect(nodeSize(1000, "directory")).toBeLessThanOrEqual(72);
    expect(nodeSize(100, "directory") - nodeSize(10, "directory")).toBeLessThan(
      nodeSize(10, "directory") - nodeSize(1, "directory") + 10,
    );
    expect(nodeSize(0, "method")).toBeLessThan(nodeSize(0, "function"));
    expect(nodeSize(Number.NaN, "file")).toBeGreaterThan(0);
  });

  it("edge width grows with log(weight) and is clamped", () => {
    expect(edgeWidth(1)).toBe(1);
    expect(edgeWidth(0)).toBe(1);
    expect(edgeWidth(10)).toBeGreaterThan(edgeWidth(2));
    expect(edgeWidth(1_000_000)).toBe(8);
  });

  it("shows edge labels only up to the limit", () => {
    expect(showEdgeLabels(EDGE_LABEL_LIMIT)).toBe(true);
    expect(showEdgeLabels(EDGE_LABEL_LIMIT + 1)).toBe(false);
  });

  it("picks the top 10 most connected nodes, ignoring isolated ones", () => {
    const nodes = Array.from({ length: 15 }, (_, i) => dir(`d${i}`, { meta: { degree: i } }));
    const { graph } = buildMapGraph({ nodes, edges: [], truncated: false });
    const top = topDegreeIds(graph.nodes);
    expect(top).toHaveLength(10);
    expect(top[0]).toBe("dir:d14");
    expect(top).not.toContain("dir:d0");
    expect(topDegreeIds(graph.nodes, 3)).toEqual(["dir:d14", "dir:d13", "dir:d12"]);
  });
});

describe("ids and groups", () => {
  it("extracts paths from ids", () => {
    expect(pathOfId("dir:")).toBe("");
    expect(pathOfId("dir:src/a")).toBe("src/a");
    expect(pathOfId("file:src/a.ts")).toBe("src/a.ts");
    expect(pathOfId("sym:src/a.ts#Foo.bar")).toBe("src/a.ts");
    expect(pathOfId("ext:react")).toBe("");
  });

  it("groups by top-level directory", () => {
    expect(topLevelGroup("dir:src/a", "directory")).toBe("src");
    expect(topLevelGroup("file:src/a.ts", "file")).toBe("src");
    expect(topLevelGroup("file:index.ts", "file")).toBe("");
    expect(topLevelGroup("ext:react", "external")).toMatch(/external/);
  });

  it("knows what can be expanded", () => {
    expect(isExpandable({ kind: "directory" }, "dir")).toBe(true);
    expect(isExpandable({ kind: "file" }, "file")).toBe(false);
    expect(isExpandable({ kind: "file" }, "symbol")).toBe(true);
    expect(isExpandable({ kind: "class" }, "symbol")).toBe(false);
  });
});

describe("palette", () => {
  it("is stable and deterministic", () => {
    expect(hashString("src")).toBe(hashString("src"));
    expect(hashString("src")).not.toBe(hashString("lib"));
    expect(groupColor("src", true)).toBe(groupColor("src", true));
    expect(paletteIndex("src")).toBe(paletteIndex("src"));
  });

  it("uses neutral colours for root files and externals, and differs by theme", () => {
    expect(paletteIndex("")).toBe(-1);
    expect(paletteIndex("\u0000external")).toBe(-1);
    expect(groupColor("", true)).not.toBe(groupColor("", false));
    expect(groupColor("src", true)).not.toBe(groupColor("src", false));
    expect(groupColor("src", true)).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe("visual encoding", () => {
  it("maps kinds to shapes and borders", () => {
    expect(nodeShape("class")).toBe("round-rectangle");
    expect(nodeShape("function")).toBe("ellipse");
    expect(nodeShape("method")).toBe("ellipse");
    expect(nodeShape("interface")).toBe("diamond");
    expect(nodeShape("file")).toBe("rectangle");
    expect(borderStyle("external")).toBe("dashed");
    expect(borderStyle("class")).toBe("solid");
  });

  it("styles edges by confidence: dashed, solid, solid and darker", () => {
    expect(edgeLook("name-match").lineStyle).toBe("dashed");
    expect(edgeLook("inferred").lineStyle).toBe("solid");
    expect(edgeLook("exact")).toEqual({ lineStyle: "solid", tone: "strong" });
    const theme = themeFromReader(() => "", false);
    expect(edgeColor("exact", theme)).not.toBe(edgeColor("inferred", theme));
    expect(edgeColor("inferred", theme)).toBe(edgeColor("name-match", theme));
  });

  it("has an arrowhead for every edge kind", () => {
    for (const kind of ["imports", "calls", "extends", "implements", "references"] as const) {
      expect(arrowShape(kind)).not.toBe("none");
    }
  });

  it("mixes hex colours and ignores malformed input", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("nonsense", "#ffffff", 0.5)).toBe("nonsense");
  });

  it("builds a style sheet for both themes", () => {
    expect(buildStylesheet(themeFromReader(() => "", false)).length).toBeGreaterThan(5);
    expect(buildStylesheet(themeFromReader(() => "", true)).length).toBeGreaterThan(5);
  });

  it("reads theme tokens and falls back when they are empty", () => {
    const fromCss = themeFromReader((n) => (n === "--fg" ? " #123456 " : ""), true);
    expect(fromCss.fg).toBe("#123456");
    expect(fromCss.dark).toBe(true);
    expect(fromCss.surface).not.toBe("");
  });
});

describe("layout options", () => {
  it("randomizes and fits only for a fresh layout", () => {
    const fresh = fcoseOptions({ nodeCount: 10, fresh: true, animate: true });
    const merge = fcoseOptions({ nodeCount: 10, fresh: false, animate: true });
    expect(fresh.randomize).toBe(true);
    expect(fresh.fit).toBe(true);
    expect(merge.randomize).toBe(false);
    expect(merge.fit).toBe(false);
  });

  it("animates only expansions, and never with reduced motion or a big graph", () => {
    expect(fcoseOptions({ nodeCount: 10, fresh: false, animate: true }).animate).toBe(true);
    expect(fcoseOptions({ nodeCount: 10, fresh: true, animate: true }).animate).toBe(false);
    expect(fcoseOptions({ nodeCount: 10, fresh: false, animate: false }).animate).toBe(false);
    expect(
      fcoseOptions({ nodeCount: DRAFT_QUALITY_THRESHOLD + 1, fresh: true, animate: true }),
    ).toMatchObject({ animate: false, quality: "draft" });
  });
});

describe("breadcrumb", () => {
  it("starts at the repository root", () => {
    expect(buildBreadcrumb("dir:", "acme/widgets")).toEqual([
      { id: "dir:", label: "acme/widgets" },
    ]);
  });

  it("lists every directory down to the root", () => {
    expect(buildBreadcrumb("dir:src/a", "r")).toEqual([
      { id: "dir:", label: "r" },
      { id: "dir:src", label: "src" },
      { id: "dir:src/a", label: "a" },
    ]);
  });

  it("ends with the file for a file root", () => {
    const crumbs = buildBreadcrumb("file:src/a.ts", "r");
    expect(crumbs.map((c) => c.id)).toEqual(["dir:", "dir:src", "file:src/a.ts"]);
  });
});

describe("png file name", () => {
  it("is file-system safe", () => {
    expect(pngFilename("widgets", "dir:")).toBe("widgets-map.png");
    expect(pngFilename("widgets", "dir:src/a b")).toBe("widgets-src-a-b.png");
    expect(pngFilename("", "dir:")).toBe("map.png");
  });
});
