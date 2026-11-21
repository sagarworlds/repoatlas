// Pure model of the file tree: no React, no network. Everything here is unit tested.
import type { GraphNode } from "../../api/types.ts";

export const ROOT_DIR_ID = "dir:";

export interface TreeItem {
  id: string;
  node: GraphNode;
  name: string;
  isDir: boolean;
  /** Repo-relative path ("src/a.ts"). */
  path: string;
  children: TreeItem[];
}

export interface TreeModel {
  /** Top level entries (children of the repository root directory). */
  roots: TreeItem[];
  byId: Map<string, TreeItem>;
}

/** One visible row of the flattened tree. */
export interface TreeRow {
  item: TreeItem;
  /** 0 for top level entries. */
  depth: number;
  /** 1-based position among its siblings, and the number of siblings (for aria). */
  posInSet: number;
  setSize: number;
  expanded: boolean;
}

function pathOfId(id: string): string {
  const colon = id.indexOf(":");
  return colon === -1 ? id : id.slice(colon + 1);
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Directories first, then files; names compared by UTF-16 code units (deterministic). */
export function compareItems(a: TreeItem, b: TreeItem): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Builds the tree from graph nodes (directories and files; other kinds are ignored).
 * A node whose parent is missing (a truncated response) is shown at the top level.
 */
export function buildTree(nodes: readonly GraphNode[]): TreeModel {
  const byId = new Map<string, TreeItem>();
  for (const node of nodes) {
    if (node.kind !== "directory" && node.kind !== "file") continue;
    if (node.id === ROOT_DIR_ID) continue;
    const path = node.file ?? pathOfId(node.id);
    byId.set(node.id, {
      id: node.id,
      node,
      name: node.name !== "" ? node.name : lastSegment(path),
      isDir: node.kind === "directory",
      path,
      children: [],
    });
  }

  const roots: TreeItem[] = [];
  for (const item of byId.values()) {
    const parent = item.node.parentId !== undefined ? byId.get(item.node.parentId) : undefined;
    if (parent?.isDir) parent.children.push(item);
    else roots.push(item);
  }
  roots.sort(compareItems);
  for (const item of byId.values()) item.children.sort(compareItems);
  return { roots, byId };
}

/** The directories that are open when the tree is first shown: the top level ones. */
export function defaultExpanded(model: TreeModel): Set<string> {
  return new Set(model.roots.filter((r) => r.isDir).map((r) => r.id));
}

/**
 * The tree entry that represents a selected node: files and directories themselves, a symbol
 * ("sym:path#Name") by its file. Anything else (module, external, repo) has none.
 */
export function treeIdForNode(nodeId: string | undefined): string | undefined {
  if (nodeId === undefined) return undefined;
  if (nodeId === ROOT_DIR_ID) return undefined;
  if (nodeId.startsWith("file:") || nodeId.startsWith("dir:")) return nodeId;
  if (nodeId.startsWith("sym:")) {
    const hash = nodeId.lastIndexOf("#");
    if (hash > 4) return `file:${nodeId.slice(4, hash)}`;
  }
  return undefined;
}

/** Ids of all directories above a tree entry, from the path alone: "file:a/b/c.ts" -> dir:a, dir:a/b. */
export function ancestorDirIds(treeId: string): string[] {
  const segments = pathOfId(treeId).split("/");
  const ids: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    ids.push(`dir:${segments.slice(0, i).join("/")}`);
  }
  return ids;
}

/**
 * Flattens the tree into the visible rows. With a non-empty `filter` only entries whose path
 * contains it (case-insensitive) and their ancestors are kept, all ancestors expanded.
 */
export function flattenTree(
  roots: readonly TreeItem[],
  expanded: ReadonlySet<string>,
  filter = "",
): TreeRow[] {
  const needle = filter.trim().toLowerCase();
  const rows: TreeRow[] = [];

  // Cache of "does this subtree contain a match", so filtering stays linear.
  const matchCache = new Map<string, boolean>();
  function subtreeMatches(item: TreeItem): boolean {
    const cached = matchCache.get(item.id);
    if (cached !== undefined) return cached;
    const result =
      item.path.toLowerCase().includes(needle) && !item.isDir
        ? true
        : item.children.some(subtreeMatches);
    matchCache.set(item.id, result);
    return result;
  }

  function visit(items: readonly TreeItem[], depth: number): void {
    const visible = needle === "" ? items : items.filter(subtreeMatches);
    visible.forEach((item, index) => {
      const isOpen = item.isDir && (needle === "" ? expanded.has(item.id) : true);
      rows.push({
        item,
        depth,
        posInSet: index + 1,
        setSize: visible.length,
        expanded: isOpen,
      });
      if (isOpen) visit(item.children, depth + 1);
    });
  }
  visit(roots, 0);
  return rows;
}

export type NavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

export type NavResult =
  | { type: "focus"; id: string }
  | { type: "expand"; id: string }
  | { type: "collapse"; id: string }
  | undefined;

/** What a navigation key does when the row `focusedId` has focus (WAI-ARIA tree pattern). */
export function navigate(
  rows: readonly TreeRow[],
  focusedId: string | undefined,
  key: NavKey,
): NavResult {
  if (rows.length === 0) return undefined;
  const index = rows.findIndex((r) => r.item.id === focusedId);
  const current = index === -1 ? undefined : rows[index];
  const focusAt = (i: number): NavResult => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    return row ? { type: "focus", id: row.item.id } : undefined;
  };

  switch (key) {
    case "Home":
      return focusAt(0);
    case "End":
      return focusAt(rows.length - 1);
    case "ArrowDown":
      return focusAt(index === -1 ? 0 : index + 1);
    case "ArrowUp":
      return focusAt(index === -1 ? 0 : index - 1);
    case "ArrowRight": {
      if (!current?.item.isDir) return undefined;
      if (!current.expanded) return { type: "expand", id: current.item.id };
      const next = rows[index + 1];
      return next && next.depth > current.depth ? { type: "focus", id: next.item.id } : undefined;
    }
    case "ArrowLeft": {
      if (!current) return undefined;
      if (current.item.isDir && current.expanded) return { type: "collapse", id: current.item.id };
      for (let i = index - 1; i >= 0; i--) {
        const candidate = rows[i];
        if (candidate && candidate.depth < current.depth) {
          return { type: "focus", id: candidate.item.id };
        }
      }
      return undefined;
    }
  }
}
