// Visual encoding of the map: shapes by kind, line style by confidence, and the Cytoscape
// style sheet. The small functions are pure so they can be unit tested; the style sheet
// only wires them up. Type-only import: Cytoscape itself is loaded lazily in cy-adapter.ts.
import type { StylesheetStyle } from "cytoscape";
import type { Confidence, EdgeKind, NodeKind } from "../../api/types.ts";
import type { MapTheme } from "./map-theme.ts";
import { groupColor } from "./palette.ts";

export type NodeShape = "rectangle" | "round-rectangle" | "ellipse" | "diamond" | "hexagon";

export function nodeShape(kind: NodeKind): NodeShape {
  switch (kind) {
    case "class":
      return "round-rectangle";
    case "interface":
      return "diamond";
    case "function":
    case "method":
      return "ellipse";
    case "module":
      return "hexagon";
    case "directory":
      return "round-rectangle"; // compound container, drawn translucent with a border
    default:
      return "rectangle"; // file, external, repo
  }
}

export function borderStyle(kind: NodeKind): "solid" | "dashed" {
  return kind === "external" ? "dashed" : "solid";
}

export interface EdgeLook {
  lineStyle: "solid" | "dashed";
  /** `strong` is a slightly darker line, used for exact edges. */
  tone: "normal" | "strong";
}

/** name-match: dashed. inferred: solid. exact: solid and slightly darker. */
export function edgeLook(confidence: Confidence): EdgeLook {
  switch (confidence) {
    case "name-match":
      return { lineStyle: "dashed", tone: "normal" };
    case "inferred":
      return { lineStyle: "solid", tone: "normal" };
    case "exact":
      return { lineStyle: "solid", tone: "strong" };
  }
}

export type ArrowShape = "triangle" | "triangle-backcurve" | "vee" | "chevron";

/** Arrowheads on every edge; the head shape separates inheritance-like kinds from calls. */
export function arrowShape(kind: EdgeKind): ArrowShape {
  switch (kind) {
    case "extends":
      return "triangle-backcurve";
    case "implements":
      return "vee";
    case "references":
      return "chevron";
    default:
      return "triangle";
  }
}

/** Mixes two #rrggbb colours (amount 0 = a, 1 = b). Used for the "slightly darker" exact edges. */
export function mixHex(a: string, b: string, amount: number): string {
  const parse = (hex: string): [number, number, number] | undefined => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (!m) return undefined;
    return [
      Number.parseInt(m[1] ?? "0", 16),
      Number.parseInt(m[2] ?? "0", 16),
      Number.parseInt(m[3] ?? "0", 16),
    ];
  };
  const ca = parse(a);
  const cb = parse(b);
  if (!ca || !cb) return a;
  const channel = (i: 0 | 1 | 2) => Math.round(ca[i] + (cb[i] - ca[i]) * amount);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(channel(0))}${hex(channel(1))}${hex(channel(2))}`;
}

/** Edge colour: a muted neutral; exact edges lean towards the foreground colour. */
export function edgeColor(confidence: Confidence, theme: MapTheme): string {
  const base = theme.dark ? "#7d8b84" : "#8a958f";
  return edgeLook(confidence).tone === "strong" ? mixHex(base, theme.fg, 0.45) : base;
}

// Cytoscape lets any style value be a function of the element ("mapper function"); the
// style sheet below uses that so colours can depend on data without per-element updates.
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function buildStylesheet(theme: MapTheme): StylesheetStyle[] {
  const labelColor = theme.fg;
  return [
    {
      selector: "node",
      style: {
        shape: (ele) => nodeShape(str(ele.data("kind")) as NodeKind),
        width: "data(size)",
        height: "data(size)",
        "background-color": (ele) => groupColor(str(ele.data("group")), theme.dark),
        "background-opacity": 0.9,
        "border-width": 1.5,
        "border-color": theme.surface,
        "border-style": (ele) => borderStyle(str(ele.data("kind")) as NodeKind),
        label: "data(label)",
        color: labelColor,
        "font-size": 11,
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 4,
        "text-wrap": "ellipsis",
        "text-max-width": "110px",
        "text-outline-color": theme.surface,
        "text-outline-width": 2,
        "min-zoomed-font-size": 7,
      },
    },
    {
      // Directories that contain other nodes: translucent container with a coloured border.
      selector: ":parent",
      style: {
        "background-opacity": 0.12,
        "border-width": 1.5,
        "border-color": (ele) => groupColor(str(ele.data("group")), theme.dark),
        "text-valign": "top",
        "text-margin-y": -4,
        "font-weight": "bold",
        padding: "14px",
      },
    },
    {
      selector: 'node[kind = "directory"]',
      style: { "background-opacity": 0.2 },
    },
    {
      selector: 'node[kind = "external"]',
      style: { "border-width": 2, "border-color": theme.muted, "background-opacity": 0.25 },
    },
    {
      selector: "node.top",
      style: { "border-width": 5, "border-style": "double", "border-color": theme.fg },
    },
    {
      selector: "node:selected",
      style: {
        "border-width": 4,
        "border-style": "solid",
        "border-color": theme.accent,
        "underlay-color": theme.accent,
        "underlay-opacity": 0.35,
        "underlay-padding": 6,
      },
    },
    {
      selector: "edge",
      style: {
        width: "data(width)",
        "curve-style": "bezier",
        "line-color": (ele) => edgeColor(str(ele.data("confidence")) as Confidence, theme),
        "line-style": (ele) => edgeLook(str(ele.data("confidence")) as Confidence).lineStyle,
        "target-arrow-shape": (ele) => arrowShape(str(ele.data("kind")) as EdgeKind),
        "target-arrow-color": (ele) => edgeColor(str(ele.data("confidence")) as Confidence, theme),
        "arrow-scale": 1,
        opacity: 0.75,
      },
    },
    {
      selector: "edge.labeled",
      style: {
        label: "data(label)",
        "font-size": 9,
        color: theme.muted,
        "text-background-color": theme.surface,
        "text-background-opacity": 0.8,
        "text-background-padding": "1px",
      },
    },
    { selector: ".faded", style: { opacity: 0.12 } },
    { selector: "node.hl", style: { opacity: 1 } },
    { selector: "edge.hl", style: { opacity: 1, "z-index": 10 } },
  ];
}
