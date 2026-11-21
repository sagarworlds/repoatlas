// Cytoscape style and layout options for the call flow graph. Cytoscape draws on a canvas
// and cannot read CSS variables, so colours arrive as a plain palette read from the theme.
import type { Confidence } from "../../api/types.ts";

export interface FlowPalette {
  fg: string;
  muted: string;
  surface: string;
  surface2: string;
  line: string;
  accent: string;
  accentSoft: string;
}

export const FALLBACK_PALETTE: FlowPalette = {
  fg: "#1b2420",
  muted: "#5a665f",
  surface: "#ffffff",
  surface2: "#eef0ea",
  line: "#d8dcd2",
  accent: "#0f766e",
  accentSoft: "#d9efe9",
};

/** Reads the theme tokens (CSS variables on :root) as concrete colours. */
export function readFlowPalette(): FlowPalette {
  if (typeof document === "undefined") return FALLBACK_PALETTE;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    fg: read("--fg", FALLBACK_PALETTE.fg),
    muted: read("--muted", FALLBACK_PALETTE.muted),
    surface: read("--surface", FALLBACK_PALETTE.surface),
    surface2: read("--surface-2", FALLBACK_PALETTE.surface2),
    line: read("--line", FALLBACK_PALETTE.line),
    accent: read("--accent", FALLBACK_PALETTE.accent),
    accentSoft: read("--accent-soft", FALLBACK_PALETTE.accentSoft),
  };
}

/** Edge look per confidence: name-match is dashed, exact is solid and a bit heavier. */
export function edgeLook(
  confidence: Confidence,
  palette: FlowPalette,
): { lineStyle: "solid" | "dashed"; width: number; color: string } {
  switch (confidence) {
    case "exact":
      return { lineStyle: "solid", width: 2.5, color: palette.fg };
    case "inferred":
      return { lineStyle: "solid", width: 2, color: palette.muted };
    case "name-match":
      return { lineStyle: "dashed", width: 2, color: palette.muted };
  }
}

/** One Cytoscape style rule (selector + properties). */
export interface FlowStyleRule {
  selector: string;
  style: Record<string, string | number>;
}

export function buildFlowStyle(palette: FlowPalette): FlowStyleRule[] {
  const confidenceRules = (["exact", "inferred", "name-match"] as const).map((c) => {
    const look = edgeLook(c, palette);
    return {
      selector: `edge[confidence = "${c}"]`,
      style: {
        "line-style": look.lineStyle,
        width: look.width,
        "line-color": look.color,
        "target-arrow-color": look.color,
      },
    };
  });
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        shape: "round-rectangle",
        width: "label",
        height: "label",
        padding: "9px",
        "text-wrap": "ellipsis",
        "text-max-width": "190px",
        "text-valign": "center",
        "text-halign": "center",
        "text-justification": "center",
        "font-size": 11,
        color: palette.fg,
        "background-color": palette.surface,
        "border-width": 1.5,
        "border-color": palette.muted,
        "min-zoomed-font-size": 6,
      },
    },
    // Kinds also differ by shape, not only by colour.
    { selector: 'node[kind = "method"]', style: { shape: "cut-rectangle" } },
    {
      selector: "node[?isFocus]",
      style: {
        "background-color": palette.accentSoft,
        "border-color": palette.accent,
        "border-width": 4,
        "font-weight": "bold",
      },
    },
    {
      selector: "edge",
      style: {
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "arrow-scale": 1.1,
        "overlay-padding": 6,
      },
    },
    ...confidenceRules,
    {
      selector: "edge:selected, edge.hover",
      style: { "line-color": palette.accent, "target-arrow-color": palette.accent, width: 4 },
    },
  ];
}

/** Dagre layout, left to right: callers on the left, the focus in the middle, callees right. */
export const FLOW_LAYOUT = {
  name: "dagre",
  rankDir: "LR",
  nodeSep: 18,
  rankSep: 90,
  padding: 24,
  animate: false,
  fit: true,
} as const;
