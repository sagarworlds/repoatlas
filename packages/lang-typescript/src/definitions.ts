import { looksLikeTestPath } from "@repoatlas/plugin-api";
import {
  type Definition,
  disambiguateLocalIds,
  MAX_SIGNATURE_LENGTH,
  type NodeMeta,
} from "@repoatlas/schema";
import ts from "typescript";
import { childNodes } from "./ast-walk.ts";
import { classifyAssignmentTarget, collectCommonJsExportedNames } from "./js-patterns.ts";
import { isJavaScriptSource } from "./source-kinds.ts";

export type DefinitionKind = Definition["kind"];

export interface CollectedDefinitions {
  definitions: Definition[];
  /**
   * Declaration node -> final localId. The key is the AST node the TypeChecker reports as a
   * symbol's declaration (e.g. the VariableDeclaration for `const f = () => {}`).
   * Map<ts.Node, ...> compares keys by reference, like a C# Dictionary with reference equality.
   */
  localIdByDecl: Map<ts.Node, { localId: string; kind: DefinitionKind }>;
}

interface Entry {
  decl: ts.Node;
  /** Further AST nodes that stand for the same definition (e.g. the whole assignment). */
  aliases: ts.Node[];
  localId: string;
  name: string;
  kind: DefinitionKind;
  parentIndex: number | undefined;
  startLine: number;
  endLine: number;
  signature: string;
  meta: NodeMeta;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === kind) === true;
}

/** Inside a `declare ...` block or a .d.ts file (bodies are not expected there). */
function isAmbient(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node; p; p = p.parent) {
    if (hasModifier(p, ts.SyntaxKind.DeclareKeyword)) return true;
    if (ts.isSourceFile(p)) return p.isDeclarationFile;
  }
  return false;
}

/** Name text of a class member / property key; undefined for computed names. */
function memberName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

/** `() => {}` or `function () {}` possibly wrapped in parentheses / `as` / `satisfies`. */
export function functionInitializer(
  init: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  let e = init;
  while (
    e &&
    (ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e))
  ) {
    e = e.expression;
  }
  return e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) ? e : undefined;
}

/** Names of `export { a, b as c }` (without "from") and `export default a`. */
function collectExportedNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause) {
      if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) names.add((el.propertyName ?? el.name).text);
      }
    } else if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) {
      names.add(st.expression.text);
    }
  }
  return names;
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_SIGNATURE_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_SIGNATURE_LENGTH - 1)}…`;
}

/** Collects the definition nodes of one file (LANGUAGE_PLUGINS section 6, TypeScript). */
export function collectDefinitions(sf: ts.SourceFile, relPath: string): CollectedDefinitions {
  const entries: Entry[] = [];
  const isJs = isJavaScriptSource(relPath);
  const exportedNames = collectExportedNames(sf);
  if (isJs) for (const name of collectCommonJsExportedNames(sf)) exportedNames.add(name);
  const isTest = looksLikeTestPath(relPath);

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  function add(
    decl: ts.Node,
    spanNode: ts.Node,
    name: string,
    kind: DefinitionKind,
    chain: string[],
    parentIndex: number | undefined,
    signature: string,
    extra: NodeMeta,
  ): number {
    const startLine = lineOf(spanNode.getStart(sf));
    const endLine = lineOf(spanNode.getEnd());
    const meta: NodeMeta = { ...extra, loc: endLine - startLine + 1 };
    if (isTest) meta.isTest = true;
    entries.push({
      decl,
      aliases: [],
      localId: [...chain, name].join("."),
      name,
      kind,
      parentIndex,
      startLine,
      endLine,
      signature: oneLine(signature),
      meta,
    });
    return entries.length - 1;
  }

  const sliceText = (from: number, to: number): string => sf.text.slice(from, to);

  /**
   * Handles one node. `chain` is the dotted name path of enclosing named scopes. Returns the
   * chain and parent entry that apply to the node's children.
   */
  function visit(
    node: ts.Node,
    chain: string[],
    parentIndex: number | undefined,
  ): { chain: string[]; parent: number | undefined } {
    let nextChain = chain;
    let nextParent = parentIndex;

    const binding = ts.isClassExpression(node) ? classExpressionBinding(node) : undefined;
    const typeDecl =
      ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
        ? node
        : binding && ts.isClassExpression(node)
          ? node
          : undefined;
    if (typeDecl) {
      const isClass = !ts.isInterfaceDeclaration(typeDecl);
      const name = binding?.name ?? typeDecl.name?.text ?? "default";
      const exported =
        binding?.exported === true ||
        hasModifier(typeDecl, ts.SyntaxKind.ExportKeyword) ||
        (parentIndex === undefined && chain.length === 0 && exportedNames.has(name));
      const meta: NodeMeta = { isExported: exported };
      if (isClass && hasModifier(typeDecl, ts.SyntaxKind.AbstractKeyword))
        meta["ts.isAbstract"] = true;
      // `members.pos` is just after the opening "{", so the header ends one character earlier.
      const signature = sliceText(typeDecl.getStart(sf), typeDecl.members.pos - 1);
      nextParent = add(
        typeDecl,
        typeDecl,
        name,
        isClass ? "class" : "interface",
        chain,
        parentIndex,
        signature,
        meta,
      );
      if (binding) entries[nextParent]?.aliases.push(...binding.aliases);
      nextChain = [...chain, name];
    } else if (ts.isFunctionDeclaration(node)) {
      // Overload signatures (no body) are skipped; the implementation is the node.
      if (node.body || isAmbient(node) || hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
        const name = node.name?.text ?? "default";
        const meta: NodeMeta = {
          isExported:
            hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
            (chain.length === 0 && exportedNames.has(name)),
        };
        if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) meta.isAsync = true;
        const end = node.body ? node.body.getStart(sf) : node.getEnd();
        nextParent = add(
          node,
          node,
          name,
          "function",
          chain,
          parentIndex,
          sliceText(node.getStart(sf), end).replace(/;\s*$/, ""),
          meta,
        );
        nextChain = [...chain, name];
      }
    } else if (
      (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) &&
      isDefinedClass(node.parent)
    ) {
      const name = ts.isConstructorDeclaration(node) ? "constructor" : memberName(node.name);
      const callable =
        node.body || isAmbient(node) || hasModifier(node, ts.SyntaxKind.AbstractKeyword);
      if (name !== undefined && callable) {
        const end = node.body ? node.body.getStart(sf) : node.getEnd();
        nextParent = add(
          node,
          node,
          name,
          "method",
          chain,
          parentIndex,
          sliceText(node.getStart(sf), end).replace(/;\s*$/, ""),
          classMemberMeta(node, entries, parentIndex),
        );
        nextChain = [...chain, name];
      }
    } else if (
      ts.isPropertyDeclaration(node) &&
      isDefinedClass(node.parent) &&
      functionInitializer(node.initializer)
    ) {
      // `handler = () => {}` as a class member counts as a method.
      const name = memberName(node.name);
      const fn = functionInitializer(node.initializer);
      if (name !== undefined && fn) {
        const meta = classMemberMeta(node, entries, parentIndex);
        if (hasModifier(fn, ts.SyntaxKind.AsyncKeyword)) meta.isAsync = true;
        nextParent = add(
          node,
          node,
          name,
          "method",
          chain,
          parentIndex,
          sliceText(node.getStart(sf), functionBodyStart(fn, sf)),
          meta,
        );
        nextChain = [...chain, name];
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      functionInitializer(node.initializer)
    ) {
      const fn = functionInitializer(node.initializer);
      const list = node.parent;
      const statement = ts.isVariableDeclarationList(list) ? list.parent : undefined;
      if (fn && ts.isVariableDeclarationList(list)) {
        const name = node.name.text;
        const exported =
          statement !== undefined &&
          ts.isVariableStatement(statement) &&
          (hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
            (chain.length === 0 && exportedNames.has(name)));
        const meta: NodeMeta = { isExported: exported };
        if (hasModifier(fn, ts.SyntaxKind.AsyncKeyword)) meta.isAsync = true;
        const keyword =
          list.flags & ts.NodeFlags.Const ? "const" : list.flags & ts.NodeFlags.Let ? "let" : "var";
        const signature = `${exported ? "export " : ""}${keyword} ${sliceText(
          node.getStart(sf),
          functionBodyStart(fn, sf),
        )}`;
        const spanNode =
          statement && ts.isVariableStatement(statement) && list.declarations.length === 1
            ? statement
            : node;
        nextParent = add(node, spanNode, name, "function", chain, parentIndex, signature, meta);
        nextChain = [...chain, name];
      }
    } else if (ts.isModuleDeclaration(node)) {
      nextChain = [...chain, node.name.text];
    } else if (isJs && chain.length === 0) {
      const found = visitJsAssignment(node);
      if (found) {
        nextChain = found.chain;
        nextParent = found.parent;
      }
    }

    return { chain: nextChain, parent: nextParent };
  }

  /** Object-literal members of `Owner.prototype = {...}` that become methods, with their owner. */
  const prototypeMembers = new Map<ts.Node, number>();

  const ownerIndex = (name: string): number | undefined => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && e.name === name && e.parentIndex === undefined && e.kind !== "method") {
        return e.kind === "function" || e.kind === "class" ? i : undefined;
      }
    }
    return undefined;
  };

  /** A method of a prototype-style class: `Owner.prototype.m = function () {}` and friends. */
  function addPrototypeMethod(
    decl: ts.Node,
    spanNode: ts.Node,
    owner: number,
    name: string,
    fn: PrototypeFunction,
    isStatic: boolean,
  ): { chain: string[]; parent: number } {
    const ownerEntry = entries[owner] as Entry;
    const meta: NodeMeta = { visibility: "public" };
    if (isStatic) meta.isStatic = true;
    else meta["js.isPrototypeMethod"] = true;
    if (hasModifier(fn, ts.SyntaxKind.AsyncKeyword)) meta.isAsync = true;
    meta.isExported = ownerEntry.meta.isExported === true;
    const chain = ownerEntry.localId.split(".");
    const index = add(
      decl,
      spanNode,
      name,
      "method",
      chain,
      owner,
      sliceText(spanNode.getStart(sf), functionBodyStart(fn, sf)),
      meta,
    );
    return { chain: [...chain, name], parent: index };
  }

  /**
   * CommonJS and prototype idioms (JavaScript files only). Returns the chain/parent for the
   * children of `node` when it declares something, otherwise undefined.
   */
  function visitJsAssignment(
    node: ts.Node,
  ): { chain: string[]; parent: number | undefined } | undefined {
    // Members of `Owner.prototype = { m() {}, n: function () {} }`, registered earlier.
    const protoOwner = prototypeMembers.get(node);
    if (protoOwner !== undefined) {
      const fn = ts.isMethodDeclaration(node)
        ? node
        : ts.isPropertyAssignment(node)
          ? functionInitializer(node.initializer)
          : undefined;
      const name = memberName((node as ts.MethodDeclaration | ts.PropertyAssignment).name);
      if (fn && name !== undefined) {
        const method = addPrototypeMethod(node, node, protoOwner, name, fn, false);
        return method;
      }
      return undefined;
    }

    if (!ts.isExpressionStatement(node)) return undefined;
    const expr = node.expression;
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
      return undefined;
    }
    const target = classifyAssignmentTarget(expr.left);
    if (!target) return undefined;
    const fn = functionInitializer(expr.right);

    if (target.kind === "prototype") {
      const owner = ownerIndex(target.owner);
      if (owner !== undefined && ts.isObjectLiteralExpression(expr.right)) {
        for (const prop of expr.right.properties) prototypeMembers.set(prop, owner);
      }
      return undefined;
    }
    if (!fn) return undefined;

    if (target.kind === "export-member" || target.kind === "module-exports") {
      const name =
        target.kind === "export-member"
          ? target.name
          : ts.isFunctionExpression(fn) && fn.name
            ? fn.name.text
            : "default";
      const meta: NodeMeta = { isExported: true };
      if (hasModifier(fn, ts.SyntaxKind.AsyncKeyword)) meta.isAsync = true;
      // The checker reports `exports.f` (the left side) for export-member and the whole
      // assignment for `module.exports = function () {}`; callers inside the body find the
      // assignment as an ancestor. Register both.
      const index = add(
        target.kind === "export-member" ? expr.left : expr,
        node,
        name,
        "function",
        [],
        undefined,
        sliceText(node.getStart(sf), functionBodyStart(fn, sf)),
        meta,
      );
      entries[index]?.aliases.push(expr, fn); // `fn`: a call signature's declaration
      return { chain: [name], parent: index };
    }

    const owner = ownerIndex(target.owner);
    if (owner === undefined) return undefined;
    const method = addPrototypeMethod(
      expr.left,
      node,
      owner,
      target.name,
      fn,
      target.kind === "static-member",
    );
    entries[method.parent]?.aliases.push(expr, fn);
    return method;
  }

  // Explicit stack instead of recursion (see ast-walk.ts); pre-order keeps parents first.
  interface Pending {
    node: ts.Node;
    chain: string[];
    parent: number | undefined;
  }
  const stack: Pending[] = [{ node: sf, chain: [], parent: undefined }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const next = visit(item.node, item.chain, item.parent);
    const children = childNodes(item.node);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child !== undefined) stack.push({ node: child, chain: next.chain, parent: next.parent });
    }
  }

  const localIds = disambiguateLocalIds(
    entries.map((e) => ({ localId: e.localId, startLine: e.startLine })),
  );
  const localIdByDecl = new Map<ts.Node, { localId: string; kind: DefinitionKind }>();
  const definitions: Definition[] = entries.map((e, i) => {
    const localId = localIds[i] ?? e.localId;
    localIdByDecl.set(e.decl, { localId, kind: e.kind });
    for (const alias of e.aliases) localIdByDecl.set(alias, { localId, kind: e.kind });
    const parentLocalId = e.parentIndex === undefined ? undefined : localIds[e.parentIndex];
    const def: Definition = {
      localId,
      kind: e.kind,
      name: e.name,
      span: { startLine: e.startLine, endLine: e.endLine },
      signature: e.signature,
      meta: e.meta,
    };
    if (parentLocalId !== undefined) def.parentLocalId = parentLocalId;
    return def;
  });
  return { definitions, localIdByDecl };
}

interface ClassExpressionBinding {
  name: string;
  exported: boolean;
  /** Other nodes the TypeChecker may report as the declaration of the same class. */
  aliases: ts.Node[];
}

/**
 * A class expression only becomes a node when it is bound to a name:
 * `const A = class {}`, `exports.A = class {}` or `module.exports = class A {}`.
 */
function classExpressionBinding(node: ts.ClassExpression): ClassExpressionBinding | undefined {
  const parent = node.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name)
  ) {
    return { name: parent.name.text, exported: false, aliases: [parent] };
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node &&
    ts.isExpressionStatement(parent.parent)
  ) {
    const target = classifyAssignmentTarget(parent.left);
    if (target?.kind === "export-member") {
      return { name: target.name, exported: true, aliases: [parent.left, parent] };
    }
    if (target?.kind === "module-exports") {
      return { name: node.name?.text ?? "default", exported: true, aliases: [parent] };
    }
  }
  return undefined;
}

/** A class declaration, or a class expression that became a node (see above). */
function isDefinedClass(node: ts.Node): boolean {
  return (
    ts.isClassDeclaration(node) ||
    (ts.isClassExpression(node) && classExpressionBinding(node) !== undefined)
  );
}

/** Where the body of an arrow/function expression starts (the signature ends there). */
function functionBodyStart(fn: PrototypeFunction, sf: ts.SourceFile): number {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return fn.equalsGreaterThanToken.getEnd();
  return fn.body ? fn.body.getStart(sf) : fn.getEnd();
}

/** Function-like nodes that can define a method outside a class body. */
type PrototypeFunction = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

function classMemberMeta(
  node: ts.ClassElement,
  entries: readonly Entry[],
  parentIndex: number | undefined,
): NodeMeta {
  const meta: NodeMeta = {};
  const isPrivate =
    hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
    (node.name !== undefined && ts.isPrivateIdentifier(node.name));
  meta.visibility = isPrivate
    ? "private"
    : hasModifier(node, ts.SyntaxKind.ProtectedKeyword)
      ? "protected"
      : "public";
  if (hasModifier(node, ts.SyntaxKind.StaticKeyword)) meta.isStatic = true;
  if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) meta.isAsync = true;
  if (hasModifier(node, ts.SyntaxKind.AbstractKeyword)) meta["ts.isAbstract"] = true;
  const parent = parentIndex === undefined ? undefined : entries[parentIndex];
  meta.isExported = parent?.meta.isExported === true && meta.visibility === "public";
  return meta;
}
