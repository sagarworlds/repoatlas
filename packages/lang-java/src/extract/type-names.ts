import type { SyntaxNode } from "@repoatlas/treesitter";

/**
 * Very common java.lang names that a repository practically never defines itself: no `type`
 * reference is made for them. Other java.lang names (System, Error, Exception, ...) do get
 * references, so a repository class with such a name is found; the resolver drops the rest
 * as external.
 */
const SKIPPED_TYPE_NAMES = new Set([
  "var",
  "String",
  "Object",
  "Integer",
  "Long",
  "Double",
  "Float",
  "Boolean",
  "Byte",
  "Short",
  "Character",
  "Math",
]);

/** Annotations from java.lang: no `type` reference is made for them. */
const SKIPPED_ANNOTATIONS = new Set([
  "Override",
  "Deprecated",
  "FunctionalInterface",
  "SuppressWarnings",
  "SafeVarargs",
]);

export function isSkippedTypeName(name: string): boolean {
  return SKIPPED_TYPE_NAMES.has(name);
}

export function isSkippedAnnotation(name: string): boolean {
  return SKIPPED_ANNOTATIONS.has(name);
}

/** A (possibly qualified) type name: `Map.Entry` is receiver "Map", name "Entry". */
export interface QualifiedName {
  name: string;
  receiver?: string;
}

export function removeWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

/** Splits `a.b.C` into receiver `a.b` and name `C`. */
export function splitQualified(text: string): QualifiedName {
  const clean = removeWhitespace(text);
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return { name: clean };
  return { name: clean.slice(dot + 1), receiver: clean.slice(0, dot) };
}

/** Child node types that wrap another type: `@Ann Foo` is an annotated_type. */
function unwrapAnnotated(node: SyntaxNode): SyntaxNode {
  if (node.type !== "annotated_type") return node;
  return (
    node.namedChildren.find((c) => c.type !== "annotation" && c.type !== "marker_annotation") ??
    node
  );
}

/**
 * The class a type node names, as written but without generics: `List<User>` gives "List",
 * `Map.Entry<K, V>` gives "Map.Entry", `a.b.Foo` gives "a.b.Foo". Arrays, primitives, `var`,
 * void and anything else give undefined (a method cannot be called on them in a way we can
 * attribute to a repository class).
 */
export function typeHint(node: SyntaxNode | null): string | undefined {
  if (node === null) return undefined;
  const type = unwrapAnnotated(node);
  switch (type.type) {
    case "type_identifier":
      return type.text === "var" ? undefined : type.text;
    case "scoped_type_identifier":
      return removeWhitespace(type.text);
    case "generic_type": {
      const inner = type.namedChildren[0];
      return inner === undefined ? undefined : typeHint(inner);
    }
    default:
      return undefined;
  }
}

/** True for `var`, which takes its type from the initializer. */
export function isVarType(node: SyntaxNode | null): boolean {
  return node !== null && node.type === "type_identifier" && node.text === "var";
}

/**
 * A comparable text for any declared type: the class name without generics (`List<X>` gives
 * "List"), primitives and `void` as written, arrays with a `[]` suffix, and "?" when the type
 * is not a plain name (`var`, wildcards). Type variables stay as written (`T`).
 */
export function typeKey(node: SyntaxNode | null): string {
  if (node === null) return "?";
  const type = unwrapAnnotated(node);
  switch (type.type) {
    case "integral_type":
    case "floating_point_type":
    case "boolean_type":
    case "void_type":
      return type.text;
    case "array_type": {
      const dims = type.childForFieldName("dimensions");
      const depth = dims === null ? 1 : dims.text.split("[").length - 1;
      return typeKey(type.childForFieldName("element")) + "[]".repeat(depth);
    }
    default:
      return typeHint(type) ?? "?";
  }
}
