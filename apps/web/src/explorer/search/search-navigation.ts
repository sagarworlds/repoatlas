import type { GraphNode, NodeKind } from "../../api/types.ts";
import type { ExplorerParams } from "../url-state.ts";

/**
 * Which tab shows a search result best, as a URL-state patch:
 * function/method -> call flow, file -> dependencies, directory -> map focused on it,
 * everything else (class, interface, module, ...) -> map with the node selected.
 * `hl` is cleared because a call-site highlight belongs to the previous selection.
 */
export function navigationForNode(node: GraphNode): Partial<ExplorerParams> {
  switch (node.kind) {
    case "function":
    case "method":
      return { tab: "flow", node: node.id, hl: undefined };
    case "file":
      return { tab: "deps", node: node.id, file: filePathOf(node), hl: undefined };
    case "directory":
      return { tab: "map", node: node.id, root: node.id, level: "dir", hl: undefined };
    default:
      return { tab: "map", node: node.id, hl: undefined };
  }
}

/** A file node's path: its `file` field, or the id without the "file:" prefix. */
function filePathOf(node: GraphNode): string {
  if (node.file !== undefined && node.file !== "") return node.file;
  return node.id.startsWith("file:") ? node.id.slice("file:".length) : node.id;
}

export interface KindFilter {
  kind: NodeKind;
  label: string;
}

/** Chips shown under the search box. No chip selected means "all kinds". */
export const KIND_FILTERS: readonly KindFilter[] = [
  { kind: "function", label: "Functions" },
  { kind: "method", label: "Methods" },
  { kind: "class", label: "Classes" },
  { kind: "interface", label: "Interfaces" },
  { kind: "file", label: "Files" },
  { kind: "directory", label: "Folders" },
];

/** Adds or removes a kind, keeping the chip order stable. */
export function toggleKind(selected: readonly NodeKind[], kind: NodeKind): NodeKind[] {
  const next = selected.includes(kind) ? selected.filter((k) => k !== kind) : [...selected, kind];
  return KIND_FILTERS.map((f) => f.kind).filter((k) => next.includes(k));
}

/** Second line of a result row: qualified name, else file path, else the id. Text only. */
export function secondaryText(node: GraphNode): string {
  if (node.kind === "file" || node.kind === "directory") return node.file ?? node.id;
  return node.qualifiedName ?? node.file ?? node.id;
}

/** Index after pressing ArrowDown (+1) or ArrowUp (-1), wrapping around. */
export function moveIndex(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  return (current + delta + count) % count;
}
