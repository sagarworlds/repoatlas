import type { Confidence } from "@repoatlas/schema";

/**
 * A binding says "in this file, the local name X refers to graph node N".
 *
 * Conventions for `nodeId` (so plugins and resolvers agree):
 * - `sym:...`  a class/function/method that exists in the SymbolIndex
 * - `file:...` an internal module (a whole file); members are looked up in `index.byFile`
 * - `mod:{lang}:{key}` an internal module node; files come from `index.moduleToFiles`
 * - `ext:...`  an external package; calls through it produce no edge
 */
export interface Binding {
  nodeId: string;
  confidence: Confidence;
  via: "import" | "local" | "wildcard" | "re-export";
}

/** localName -> binding, for one file. */
export type BindingMap = Map<string, Binding>;

/**
 * Adds a binding. Explicit names shadow wildcard names: a wildcard binding never replaces
 * an existing explicit one, while an explicit binding always replaces a wildcard one.
 * Otherwise the later binding wins (Python: a later import rebinds the name).
 */
export function addBinding(map: BindingMap, localName: string, binding: Binding): void {
  const existing = map.get(localName);
  if (existing && binding.via === "wildcard" && existing.via !== "wildcard") return;
  map.set(localName, binding);
}

/** Returns a new map: `base` entries first, then `overrides` added with the shadowing rule. */
export function mergeBindingMaps(base: BindingMap, overrides: BindingMap): BindingMap {
  const result: BindingMap = new Map(base);
  for (const [name, binding] of overrides) addBinding(result, name, binding);
  return result;
}

export function isExternalId(nodeId: string): boolean {
  return nodeId.startsWith("ext:");
}

export function isFileId(nodeId: string): boolean {
  return nodeId.startsWith("file:");
}

/**
 * True for a symbol that is not nested in another symbol. The pipeline gives such symbols
 * the file node as parent (`parentId` = `file:...`); a bare index may leave it undefined.
 */
export function isTopLevelSymbol(node: { parentId?: string | undefined }): boolean {
  return node.parentId === undefined || isFileId(node.parentId);
}

export function isModuleId(nodeId: string): boolean {
  return nodeId.startsWith("mod:");
}
