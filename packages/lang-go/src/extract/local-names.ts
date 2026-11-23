import type { SyntaxNode } from "@repoatlas/treesitter";
import { isLocalName } from "../spec/receiver-type.ts";

/** Call sites whose callee name is a local variable or parameter (it shadows outer names). */
export interface LocalCallFacts {
  /** `${line}|${name}` of bare calls `f()` where `f` is a local variable or parameter. */
  bareCalls: Set<string>;
  /** `${line}|${name}` of `x.M()` calls where `x` is a local variable or parameter. */
  receivers: Set<string>;
}

/** One linear walk over the tree, finding calls made through locally bound names. */
export function collectLocalCallFacts(root: SyntaxNode): LocalCallFacts {
  const facts: LocalCallFacts = { bareCalls: new Set(), receivers: new Set() };
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const line = node.startPosition.row + 1;
      if (fn?.type === "identifier" && isLocalName(fn, fn.text)) {
        facts.bareCalls.add(`${line}|${fn.text}`);
      } else if (fn?.type === "selector_expression") {
        const operand = fn.childForFieldName("operand");
        if (operand?.type === "identifier" && isLocalName(operand, operand.text)) {
          facts.receivers.add(`${line}|${operand.text}`);
        }
      }
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  return facts;
}
