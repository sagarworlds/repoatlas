import { type Definition, disambiguateLocalIds } from "@repoatlas/schema";

/** One definition found by the definitions query, before nesting is known. */
export interface DefinitionCandidate {
  kind: Definition["kind"];
  name: string;
  /** tree-sitter node type of the definition node, e.g. "class_definition". */
  nodeType: string;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
  signature?: string;
}

export interface BuiltDefinition {
  definition: Definition;
  /** Index of the source candidate in the input array (to find its syntax node again). */
  candidateIndex: number;
}

/**
 * Builds the definition tree from flat candidates (pure, no WASM):
 * - nesting is decided by span containment of the definition nodes;
 * - localId = parent's final localId + "." + name (top level: just the name), so nested
 *   functions get ids like "outer.inner" and methods "User.save";
 * - a "function" whose nearest enclosing definition is a container (`containerTypes`)
 *   becomes a "method";
 * - id collisions are resolved with the schema's `disambiguateLocalIds` ("foo@42"),
 *   level by level so children of a renamed parent follow its new id.
 * Output is in document order (parents before children).
 */
export function buildDefinitions(
  candidates: readonly DefinitionCandidate[],
  containerTypes: readonly string[],
): BuiltDefinition[] {
  const order = candidates
    .map((_, i) => i)
    .sort((a, b) => {
      const ca = candidates[a] as DefinitionCandidate;
      const cb = candidates[b] as DefinitionCandidate;
      return ca.startIndex - cb.startIndex || cb.endIndex - ca.endIndex || a - b;
    });

  // Pass 1: find each candidate's parent with a stack (positions in `order`).
  const parentOf: number[] = [];
  const depthOf: number[] = [];
  const stack: number[] = [];
  order.forEach((candidateIndex, pos) => {
    const c = candidates[candidateIndex] as DefinitionCandidate;
    while (stack.length > 0) {
      const top = candidates[order[stack.at(-1) as number] as number] as DefinitionCandidate;
      if (top.endIndex <= c.startIndex || top.endIndex < c.endIndex) stack.pop();
      else break;
    }
    const parentPos = stack.length > 0 ? (stack.at(-1) as number) : -1;
    parentOf[pos] = parentPos;
    depthOf[pos] = parentPos === -1 ? 0 : (depthOf[parentPos] as number) + 1;
    stack.push(pos);
  });

  // Pass 2: assign ids depth by depth so a child can use its parent's final id.
  const finalIds: string[] = new Array<string>(order.length).fill("");
  const finalised: { localId: string; startLine: number }[] = [];
  const maxDepth = depthOf.reduce((m, d) => Math.max(m, d), 0);
  for (let depth = 0; depth <= maxDepth; depth++) {
    const level: { pos: number; raw: string; startLine: number }[] = [];
    order.forEach((candidateIndex, pos) => {
      if (depthOf[pos] !== depth) return;
      const c = candidates[candidateIndex] as DefinitionCandidate;
      const parentPos = parentOf[pos] as number;
      const raw = parentPos === -1 ? c.name : `${finalIds[parentPos]}.${c.name}`;
      level.push({ pos, raw, startLine: c.startLine });
    });
    const ids = disambiguateLocalIds([
      ...finalised,
      ...level.map((l) => ({ localId: l.raw, startLine: l.startLine })),
    ]).slice(finalised.length);
    level.forEach((l, i) => {
      const id = ids[i] as string;
      finalIds[l.pos] = id;
      finalised.push({ localId: id, startLine: l.startLine });
    });
  }

  return order.map((candidateIndex, pos) => {
    const c = candidates[candidateIndex] as DefinitionCandidate;
    const parentPos = parentOf[pos] as number;
    const parentCandidate =
      parentPos === -1
        ? undefined
        : (candidates[order[parentPos] as number] as DefinitionCandidate);
    const isMethod =
      c.kind === "method" ||
      (c.kind === "function" &&
        parentCandidate !== undefined &&
        containerTypes.includes(parentCandidate.nodeType));
    const definition: Definition = {
      localId: finalIds[pos] as string,
      kind: isMethod ? "method" : c.kind,
      name: c.name,
      span: { startLine: c.startLine, endLine: c.endLine },
    };
    if (parentPos !== -1) definition.parentLocalId = finalIds[parentPos] as string;
    if (c.signature !== undefined) definition.signature = c.signature;
    return { definition, candidateIndex };
  });
}
