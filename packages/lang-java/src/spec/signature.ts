import type { SyntaxNode } from "@repoatlas/treesitter";

const COMMENT_TYPES = new Set(["line_comment", "block_comment"]);

/** Keyword modifiers (`public`, `static`, ...) without annotations. */
function modifierKeywords(node: SyntaxNode): string[] {
  const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
  if (modifiers === undefined) return [];
  return modifiers.children
    .filter((c) => c.type !== "marker_annotation" && c.type !== "annotation")
    .map((c) => c.text);
}

/** `(boolean force, String... names)` rebuilt from the parameter nodes (comments disappear). */
function parameterList(params: SyntaxNode | null): string {
  if (params === null) return "";
  const parts = params.namedChildren.filter((c) => !COMMENT_TYPES.has(c.type)).map((c) => c.text);
  return `(${parts.join(", ")})`;
}

function childText(node: SyntaxNode, type: string): string | undefined {
  return node.namedChildren.find((c) => c.type === type)?.text;
}

function joinParts(parts: (string | undefined)[]): string {
  return parts.filter((p) => p !== undefined && p !== "").join(" ");
}

function typeSignature(node: SyntaxNode, name: string): string | undefined {
  const typeParams = node.childForFieldName("type_parameters")?.text ?? "";
  const head = `${name}${typeParams}`;
  switch (node.type) {
    case "class_declaration":
      return joinParts([
        "class",
        head,
        node.childForFieldName("superclass")?.text,
        node.childForFieldName("interfaces")?.text,
      ]);
    case "interface_declaration":
      return joinParts(["interface", head, childText(node, "extends_interfaces")]);
    case "enum_declaration":
      return joinParts(["enum", head, node.childForFieldName("interfaces")?.text]);
    case "record_declaration":
      return joinParts([
        `record ${head}${parameterList(node.childForFieldName("parameters"))}`,
        node.childForFieldName("interfaces")?.text,
      ]);
    case "annotation_type_declaration":
      return `@interface ${name}`;
    default:
      return undefined;
  }
}

/**
 * One-line signature without the body:
 *   method:      `public User save(boolean force) throws IOException`
 *   constructor: `public User(String name)`
 *   class:       `class User<T> extends Base implements A, B` (modifiers are in meta)
 * The engine collapses whitespace and truncates to the schema limit afterwards.
 */
export function javaSignature(node: SyntaxNode): string | undefined {
  const name = node.childForFieldName("name")?.text;
  if (name === undefined) return undefined;
  if (node.type === "method_declaration" || node.type === "constructor_declaration") {
    const returns =
      node.type === "method_declaration" ? node.childForFieldName("type")?.text : undefined;
    const dims = node.childForFieldName("dimensions")?.text ?? "";
    const call = `${name}${parameterList(node.childForFieldName("parameters"))}${dims}`;
    return joinParts([
      ...modifierKeywords(node),
      node.childForFieldName("type_parameters")?.text,
      returns,
      call,
      childText(node, "throws"),
    ]);
  }
  if (node.type === "compact_constructor_declaration") {
    return joinParts([...modifierKeywords(node), name]);
  }
  return typeSignature(node, name);
}
