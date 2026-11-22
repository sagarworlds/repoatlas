import type { SyntaxNode } from "@repoatlas/treesitter";

/** `(a, b: int = 1)` rebuilt from the child nodes so comments inside it disappear. */
function listText(node: SyntaxNode | null): string {
  if (node === null) return "";
  const parts = node.namedChildren.filter((c) => c.type !== "comment").map((c) => c.text);
  return `(${parts.join(", ")})`;
}

/**
 * One-line signature, without the body:
 *   function: `[async ]save(self, force: bool = False) -> None`
 *   class:    `class User(Base, Mixin)`
 * The engine collapses whitespace and truncates to the schema limit afterwards.
 */
export function pythonSignature(node: SyntaxNode): string | undefined {
  const name = node.childForFieldName("name")?.text;
  if (name === undefined) return undefined;
  if (node.type === "class_definition") {
    const bases = node.childForFieldName("superclasses");
    return `class ${name}${bases === null ? "" : listText(bases)}`;
  }
  if (node.type !== "function_definition") return undefined;
  const isAsync = node.children.some((c) => c.type === "async");
  const returns = node.childForFieldName("return_type");
  const ret = returns === null ? "" : ` -> ${returns.text}`;
  return `${isAsync ? "async " : ""}${name}${listText(node.childForFieldName("parameters"))}${ret}`;
}
