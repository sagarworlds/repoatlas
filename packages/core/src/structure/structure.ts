import {
  dirId,
  fileId,
  type GraphEdge,
  type GraphNode,
  type LanguageId,
  repoId,
  toPosixPath,
} from "@repoatlas/schema";

export interface StructureFile {
  path: string;
  language?: LanguageId | undefined;
  bytes: number;
  loc?: number | undefined;
  isTest?: boolean | undefined;
}

export interface StructureInput {
  repoName: string;
  /** Only files claimed by a plugin (source files). Others get no node. */
  files: StructureFile[];
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Parent directory path; "" for files/dirs directly under the root. */
function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Directory paths above a file, outermost first, excluding the root: "a/b/c.ts" -> ["a","a/b"]. */
function dirsAbove(filePath: string): string[] {
  const parts = filePath.split("/").slice(0, -1);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(0, i + 1).join("/"));
  return out;
}

function contains(src: string, dst: string): GraphEdge {
  return { src, dst, kind: "contains", confidence: "exact" };
}

/**
 * Builds the repo node, directory nodes and file nodes with `parentId` + `contains` edges.
 * Directories with no claimed file below them are not created. Output is sorted by path.
 */
export function buildStructure(input: StructureInput): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const files = [...input.files]
    .map((f) => ({ ...f, path: toPosixPath(f.path) }))
    .sort((a, b) => compareCodeUnits(a.path, b.path));

  const dirPaths = new Set<string>();
  const dirsWithNonTest = new Set<string>(); // a dir is a test dir when no non-test file is below
  for (const f of files) {
    for (const d of dirsAbove(f.path)) {
      dirPaths.add(d);
      if (f.isTest !== true) dirsWithNonTest.add(d);
    }
  }
  const sortedDirs = [...dirPaths].sort(compareCodeUnits);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  nodes.push({ id: repoId(), kind: "repo", name: input.repoName });
  nodes.push({ id: dirId(""), kind: "directory", name: input.repoName, parentId: repoId() });
  edges.push(contains(repoId(), dirId("")));

  for (const path of sortedDirs) {
    const parent = dirId(parentPath(path));
    const dirNode: GraphNode = {
      id: dirId(path),
      kind: "directory",
      name: baseName(path),
      parentId: parent,
    };
    if (!dirsWithNonTest.has(path)) dirNode.meta = { isTest: true };
    nodes.push(dirNode);
    edges.push(contains(parent, dirId(path)));
  }

  for (const f of files) {
    const parent = dirId(parentPath(f.path));
    const node: GraphNode = {
      id: fileId(f.path),
      kind: "file",
      name: baseName(f.path),
      file: f.path,
      parentId: parent,
    };
    if (f.language !== undefined) node.language = f.language;
    const meta: NonNullable<GraphNode["meta"]> = {};
    if (f.loc !== undefined) meta.loc = f.loc;
    if (f.isTest === true) meta.isTest = true;
    if (Object.keys(meta).length > 0) node.meta = meta;
    nodes.push(node);
    edges.push(contains(parent, node.id));
  }

  return { nodes, edges };
}
