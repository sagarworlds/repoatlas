import ts from "typescript";

/**
 * The direct children of a node, in source order.
 *
 * The walkers in this package use an explicit stack instead of recursion: a long chain of
 * binary operators (a string table written as "a" + "b" + ..., generated code) is a
 * left-deep tree that is thousands of levels deep, and a recursive visitor would overflow
 * the call stack.
 */
export function childNodes(node: ts.Node): ts.Node[] {
  const children: ts.Node[] = [];
  // The callback must not return a truthy value, or forEachChild stops early.
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  return children;
}

/**
 * Pre-order walk without recursion. `visit` returns `false` to skip the children of a node.
 */
export function walkPreOrder(root: ts.Node, visit: (node: ts.Node) => boolean | undefined): void {
  const stack: ts.Node[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (visit(node) === false) continue;
    const children = childNodes(node);
    // Push in reverse so the first child is visited first (source order).
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child !== undefined) stack.push(child);
    }
  }
}
