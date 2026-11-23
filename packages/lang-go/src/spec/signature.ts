import type { SyntaxNode } from "@repoatlas/treesitter";

/** `(a int, b string)` rebuilt from the child nodes so comments inside it disappear. */
function listText(node: SyntaxNode | null): string {
  if (node === null) return "";
  const parts = node.namedChildren.filter((c) => c.type !== "comment").map((c) => c.text);
  return `(${parts.join(", ")})`;
}

function fieldText(node: SyntaxNode, field: string): string {
  const child = node.childForFieldName(field);
  return child === null ? "" : child.text;
}

function typeParameters(node: SyntaxNode): string {
  const params = node.childForFieldName("type_parameters");
  if (params === null) return "";
  const parts = params.namedChildren.filter((c) => c.type !== "comment").map((c) => c.text);
  return `[${parts.join(", ")}]`;
}

/**
 * One-line signature, without the body. The engine collapses whitespace and truncates.
 *   function: `func NewServer(addr string) *Server`
 *   method:   `func (s *Server) Start(ctx context.Context) error`
 *   struct:   `type Server struct`        interface: `type Store interface`
 *   other:    `type ID int`, `type Handler func(w Writer)`, alias `type B = A`
 */
export function goSignature(node: SyntaxNode): string | undefined {
  const name = fieldText(node, "name");
  if (name === "") return undefined;
  if (node.type === "function_declaration" || node.type === "method_declaration") {
    const receiver = node.childForFieldName("receiver");
    const recv = receiver === null ? "" : `${listText(receiver)} `;
    const result = node.childForFieldName("result");
    let ret = "";
    if (result !== null) {
      ret = result.type === "parameter_list" ? ` ${listText(result)}` : ` ${result.text}`;
    }
    const params = listText(node.childForFieldName("parameters"));
    return `func ${recv}${name}${typeParameters(node)}${params}${ret}`;
  }
  if (node.type === "type_spec" || node.type === "type_alias") {
    const type = node.childForFieldName("type");
    const head = `type ${name}${typeParameters(node)}`;
    if (type === null) return head;
    if (type.type === "struct_type") return `${head} struct`;
    if (type.type === "interface_type") return `${head} interface`;
    return node.type === "type_alias" ? `${head} = ${type.text}` : `${head} ${type.text}`;
  }
  return undefined;
}
