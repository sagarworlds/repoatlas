import { makeEdge } from "@repoatlas/plugin-api";
import { fileId, type GraphEdge, type Unresolved } from "@repoatlas/schema";
import ts from "typescript";
import { walkPreOrder } from "./ast-walk.ts";
import type { DefinitionKind } from "./definitions.ts";

/** Our graph node that a TypeScript declaration maps to. */
export interface NodeRef {
  id: string;
  kind: DefinitionKind;
}

export interface EdgeExtraction {
  edges: GraphEdge[];
  unresolved: Unresolved[];
}

const MAX_AMBIGUOUS_CALLEES = 4;

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/** The identifier whose symbol tells us what `expr` refers to (`a.b.c` -> `c`). */
function nameNodeOf(expr: ts.Expression): ts.Node | undefined {
  if (ts.isIdentifier(expr)) return expr;
  if (ts.isPropertyAccessExpression(expr)) return expr.name;
  return undefined;
}

/**
 * Extracts calls / extends / implements / references edges for one source file using the
 * TypeChecker. Only declarations that are nodes in our graph (`nodes`) become edge targets;
 * calls into libraries produce nothing.
 */
export function extractFileEdges(
  sf: ts.SourceFile,
  filePath: string,
  checker: ts.TypeChecker,
  nodes: ReadonlyMap<ts.Node, NodeRef>,
): EdgeExtraction {
  const edges: GraphEdge[] = [];
  const unresolved: Unresolved[] = [];
  const thisFile = fileId(filePath);

  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  /** Nearest enclosing definition, or the file itself for top-level code. */
  function enclosingId(node: ts.Node): string {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      const ref = nodes.get(p);
      if (ref) return ref.id;
    }
    return thisFile;
  }

  /**
   * Source of a calls edge: the nearest enclosing function or method. Code that runs
   * directly in a class body (property initializers, accessors, which are not nodes) is
   * not a class "calling" something, so the search continues outwards and ends at the file.
   */
  function callerId(node: ts.Node): string {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      const ref = nodes.get(p);
      if (ref && (ref.kind === "function" || ref.kind === "method")) return ref.id;
    }
    return thisFile;
  }

  /**
   * Follows import/export aliases (also through re-exports) to the symbol's declarations that
   * are nodes in our graph. Usually one; a property of a union-typed receiver or a method
   * assigned in several places has several (distinct ids, in declaration order).
   */
  function refsOf(symbol: ts.Symbol | undefined, depth = 0): NodeRef[] {
    if (!symbol) return [];
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const decls = target.declarations ?? [];
    const found = new Map<string, NodeRef>();
    for (const decl of decls) {
      const ref = nodes.get(decl);
      if (ref) found.set(ref.id, ref);
    }
    if (found.size > 0 || depth >= 5) return [...found.values()];
    // CommonJS `module.exports = { a, b: c }`: the property is only a pointer to the function
    // declared elsewhere in the file, so follow it (depth-limited against pointer cycles).
    for (const decl of decls) {
      let next: ts.Symbol | undefined;
      if (ts.isShorthandPropertyAssignment(decl)) {
        next = checker.getShorthandAssignmentValueSymbol(decl);
      } else if (ts.isPropertyAssignment(decl) && ts.isIdentifier(decl.initializer)) {
        next = checker.getSymbolAtLocation(decl.initializer);
      }
      for (const ref of refsOf(next, depth + 1)) found.set(ref.id, ref);
    }
    return [...found.values()];
  }

  function refOf(symbol: ts.Symbol | undefined): NodeRef | undefined {
    return refsOf(symbol)[0];
  }

  function refOfName(expr: ts.Expression | ts.EntityName): NodeRef | undefined {
    const nameNode = ts.isQualifiedName(expr) ? expr.right : nameNodeOf(expr as ts.Expression);
    return nameNode ? refOf(checker.getSymbolAtLocation(nameNode)) : undefined;
  }

  /** For `new X()` / `super()`: the constructor implementation behind the chosen overload. */
  function constructorRef(node: ts.CallExpression | ts.NewExpression): NodeRef | undefined {
    const decl = checker.getResolvedSignature(node)?.declaration;
    if (!decl || !ts.isConstructorDeclaration(decl)) return undefined;
    const direct = nodes.get(decl);
    if (direct) return direct;
    for (const member of decl.parent.members) {
      if (ts.isConstructorDeclaration(member)) {
        const ref = nodes.get(member);
        if (ref) return ref;
      }
    }
    return undefined;
  }

  function handleCall(call: ts.CallExpression): void {
    const expr = unwrap(call.expression);
    if (expr.kind === ts.SyntaxKind.SuperKeyword) {
      const ref = constructorRef(call);
      if (ref) edges.push(makeEdge(callerId(call), ref.id, "calls", "exact", lineOf(call)));
      return;
    }
    if (expr.kind === ts.SyntaxKind.ImportKeyword) return;
    // Immediately-invoked function expressions: their body belongs to the enclosing definition.
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return;

    const nameNode = nameNodeOf(expr);
    const symbol = nameNode ? checker.getSymbolAtLocation(nameNode) : undefined;
    if (symbol) {
      const callees = refsOf(symbol).filter((r) => r.kind === "function" || r.kind === "method");
      // One target is exact. A few candidates (the receiver can be one of several types) are
      // all recorded as inferred; a long list is too ambiguous to be worth any edge.
      if (callees.length >= 1 && callees.length <= MAX_AMBIGUOUS_CALLEES) {
        const confidence = callees.length === 1 ? "exact" : "inferred";
        for (const ref of callees) {
          edges.push(makeEdge(callerId(call), ref.id, "calls", confidence, lineOf(call)));
        }
      }
      return; // a symbol outside our graph (library, parameter, interface member): no edge
    }
    // No symbol at all (the callee is itself a call, `f(1)('x')`). The
    // resolved signature still names the declaration being invoked: a function in our graph
    // gives an edge, a declaration outside it (library typings, interface member) is an
    // external call like the case above.
    const signatureDecl = ts.isCallExpression(expr)
      ? checker.getResolvedSignature(call)?.declaration
      : undefined;
    if (signatureDecl) {
      // `const f = () => {}` is registered under its VariableDeclaration, the parent.
      const ref = nodes.get(signatureDecl) ?? nodes.get(signatureDecl.parent);
      if (ref && (ref.kind === "function" || ref.kind === "method")) {
        edges.push(makeEdge(callerId(call), ref.id, "calls", "exact", lineOf(call)));
      }
      return;
    }
    // `any`-typed values (usually from unresolvable imports) are external
    // calls and not interesting; anything else is genuinely unresolved (dynamic dispatch).
    const type = checker.getTypeAtLocation(expr);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
    unresolved.push({
      file: filePath,
      line: lineOf(call),
      name: expr.getText(sf).replace(/\s+/g, " ").slice(0, 80),
      kind: "call",
    });
  }

  function handleNew(node: ts.NewExpression): void {
    const cls = refOfName(unwrap(node.expression));
    const ctor = constructorRef(node);
    // A class without its own constructor resolves to the BASE class constructor. That is a
    // call into the base, but the thing being instantiated is the derived class, so fall
    // through to a `references` edge to it.
    const ctorDecl = checker.getResolvedSignature(node)?.declaration;
    const owner =
      ctorDecl && ts.isConstructorDeclaration(ctorDecl) ? nodes.get(ctorDecl.parent) : undefined;
    const inherited = cls !== undefined && owner !== undefined && owner.id !== cls.id;
    if (ctor && !inherited) {
      edges.push(makeEdge(callerId(node), ctor.id, "calls", "exact", lineOf(node)));
      return;
    }
    if (cls?.kind === "class") {
      edges.push(makeEdge(callerId(node), cls.id, "references", "exact", lineOf(node)));
    } else if (cls?.kind === "function") {
      // `new Animal()` where `function Animal() {}` is a prototype-style constructor.
      edges.push(makeEdge(callerId(node), cls.id, "calls", "exact", lineOf(node)));
    }
  }

  function handleHeritage(
    node: ts.ClassDeclaration | ts.ClassExpression | ts.InterfaceDeclaration,
  ): void {
    const self = nodes.get(node);
    if (!self || !node.heritageClauses) return;
    for (const clause of node.heritageClauses) {
      const kind = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
      for (const type of clause.types) {
        const target = refOfName(type.expression);
        if (target && (target.kind === "class" || target.kind === "interface")) {
          edges.push(makeEdge(self.id, target.id, kind, "exact", lineOf(type)));
        }
      }
    }
  }

  function handleTypeReference(node: ts.TypeReferenceNode): void {
    const target = refOfName(node.typeName);
    if (!target || (target.kind !== "class" && target.kind !== "interface")) return;
    const src = enclosingId(node);
    if (src === target.id) return;
    edges.push(makeEdge(src, target.id, "references", "exact", lineOf(node)));
  }

  function handleJsx(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): void {
    const tag = node.tagName;
    if (!ts.isIdentifier(tag) && !ts.isPropertyAccessExpression(tag)) return;
    const target = refOfName(tag);
    if (!target) return;
    const kind =
      target.kind === "function" ? "calls" : target.kind === "class" ? "references" : undefined;
    if (kind) edges.push(makeEdge(callerId(node), target.id, kind, "exact", lineOf(node)));
  }

  function visit(node: ts.Node): boolean {
    if (ts.isCallExpression(node)) handleCall(node);
    else if (ts.isNewExpression(node)) handleNew(node);
    else if (
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isInterfaceDeclaration(node)
    ) {
      handleHeritage(node);
    } else if (ts.isTypeReferenceNode(node)) handleTypeReference(node);
    else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) handleJsx(node);
    return true;
  }

  walkPreOrder(sf, visit);
  return { edges, unresolved };
}
