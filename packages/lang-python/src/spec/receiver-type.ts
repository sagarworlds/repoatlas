import type { ReceiverTypeContext, SyntaxNode } from "@repoatlas/treesitter";
import { annotationToTypeHint } from "../extract/annotations.ts";

/** What one binding of a variable tells us: a class name, or "unknown" (undefined). */
interface Binding {
  hint: string | undefined;
}

const SCOPE_BOUNDARIES = new Set(["function_definition", "class_definition", "lambda"]);

/** `x = Foo(...)` gives "Foo" (also `mod.Foo(...)`). Only CapitalisedNames count as classes. */
function constructorHint(value: SyntaxNode | null): string | undefined {
  let current = value;
  // `a = b = Foo()` parses as assignment(left a, right: assignment(left b, right call)).
  while (current !== null && current.type === "assignment")
    current = current.childForFieldName("right");
  if (current === null || current.type !== "call") return undefined;
  const callee = current.childForFieldName("function");
  if (callee === null) return undefined;
  if (callee.type !== "identifier" && callee.type !== "attribute") return undefined;
  const text = callee.text.replace(/\s+/g, "");
  const last = text.slice(text.lastIndexOf(".") + 1);
  return /^[A-Z]/.test(last) ? text : undefined;
}

/** `None` on the right of an assignment: it does not tell the class of the variable. */
function isNoneValue(value: SyntaxNode | null): boolean {
  return value !== null && value.type === "none";
}

/** Identifier names bound by an assignment target (`x`, `a, b`, `(a, b)`, `*rest`). */
function targetNames(target: SyntaxNode | null): string[] {
  if (target === null) return [];
  if (target.type === "identifier") return [target.text];
  if (
    ["pattern_list", "tuple_pattern", "list_pattern", "list_splat_pattern"].includes(target.type)
  ) {
    return target.namedChildren.flatMap((c) => targetNames(c));
  }
  return [];
}

/** name -> every binding of that name in one scope. */
type BindingTable = Map<string, Binding[]>;

function addBinding(table: BindingTable, name: string, hint: string | undefined): void {
  const list = table.get(name);
  if (list === undefined) table.set(name, [{ hint }]);
  else list.push({ hint });
}

function typeHint(node: SyntaxNode): string | undefined {
  const type = node.childForFieldName("type");
  return type === null ? undefined : annotationToTypeHint(type);
}

function parameterBindings(fn: SyntaxNode, table: BindingTable): void {
  const params = fn.childForFieldName("parameters");
  if (params === null) return;
  for (const p of params.namedChildren) {
    if (p.type === "identifier") {
      addBinding(table, p.text, undefined);
    } else if (p.type === "typed_parameter") {
      const id = p.namedChildren.find((c) => c.type !== "type");
      const inner = id?.type === "identifier" ? id : id?.namedChildren[0];
      if (inner !== undefined) addBinding(table, inner.text, typeHint(p));
    } else if (p.type === "typed_default_parameter") {
      const name = p.childForFieldName("name");
      if (name !== null) addBinding(table, name.text, typeHint(p));
    } else if (p.type === "default_parameter") {
      const name = p.childForFieldName("name");
      if (name !== null) addBinding(table, name.text, undefined);
    } else {
      // *args / **kwargs
      for (const n of targetNames(p)) addBinding(table, n, undefined);
      for (const c of p.namedChildren) addBinding(table, c.text, undefined);
    }
  }
}

/** Local names an import statement binds (`import a.b` binds `a`; `as x` binds `x`). */
function importedNames(node: SyntaxNode): string[] {
  const out: string[] = [];
  for (const n of node.childrenForFieldName("name")) {
    if (n.type === "aliased_import") {
      const alias = n.childForFieldName("alias");
      if (alias !== null) out.push(alias.text);
    } else if (node.type === "import_statement") {
      out.push(n.text.split(".")[0] ?? n.text);
    } else {
      out.push(n.text);
    }
  }
  return out;
}

/**
 * Every binding of every name inside `scope` in ONE linear walk (not looking into nested
 * defs/classes/lambdas). Looking names up in the table afterwards keeps inference linear.
 */
function collectScopeBindings(scope: SyntaxNode): BindingTable {
  const table: BindingTable = new Map();
  if (scope.type === "function_definition") parameterBindings(scope, table);
  const stack: SyntaxNode[] = [...scope.namedChildren];
  // For a def, only its body (parameters were handled above, decorators do not bind).
  if (scope.type === "function_definition" || scope.type === "class_definition") {
    stack.length = 0;
    const body = scope.childForFieldName("body");
    if (body !== null) stack.push(body);
  }
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    if (SCOPE_BOUNDARIES.has(node.type)) {
      if (node.type !== "lambda") {
        const n = node.childForFieldName("name");
        if (n !== null) addBinding(table, n.text, undefined); // def/class rebinding the name
      }
      continue;
    }
    switch (node.type) {
      case "assignment": {
        const left = node.childForFieldName("left");
        if (isNoneValue(node.childForFieldName("right"))) break; // x = None keeps the class
        if (left !== null && left.type === "identifier") {
          const type = node.childForFieldName("type");
          const hint =
            type !== null
              ? annotationToTypeHint(type)
              : constructorHint(node.childForFieldName("right"));
          addBinding(table, left.text, hint);
        } else {
          for (const n of targetNames(left)) addBinding(table, n, undefined);
        }
        break;
      }
      case "augmented_assignment":
        for (const n of targetNames(node.childForFieldName("left")))
          addBinding(table, n, undefined);
        break;
      case "named_expression": {
        const name = node.childForFieldName("name");
        if (name !== null)
          addBinding(table, name.text, constructorHint(node.childForFieldName("value")));
        break;
      }
      case "for_statement":
      case "for_in_clause":
        for (const n of targetNames(node.childForFieldName("left")))
          addBinding(table, n, undefined);
        break;
      case "as_pattern_target":
        for (const n of targetNames(node.namedChildren[0] ?? null)) addBinding(table, n, undefined);
        break;
      case "import_statement":
      case "import_from_statement":
        for (const n of importedNames(node)) addBinding(table, n, undefined);
        break;
      default:
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  return table;
}

/** The hint of one binding of `self.x`: annotation, constructor call, or an annotated parameter. */
function attributeValueHint(
  assignment: SyntaxNode,
  fn: SyntaxNode | null,
  root: SyntaxNode,
): string | undefined {
  const type = assignment.childForFieldName("type");
  if (type !== null) return annotationToTypeHint(type);
  const right = assignment.childForFieldName("right");
  const viaConstructor = constructorHint(right);
  if (viaConstructor !== undefined) return viaConstructor;
  // `self.session = session` with `session: Session` as a parameter of the same method.
  if (right !== null && right.type === "identifier")
    return unifiedHint(bindingsFor(fn ?? undefined, root, right.text));
  return undefined;
}

function unifiedHint(bindings: Binding[]): string | undefined {
  const first = bindings[0]?.hint;
  if (first === undefined) return undefined;
  return bindings.every((b) => b.hint === first) ? first : undefined;
}

function enclosingOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  let current: SyntaxNode | null = node.parent;
  while (current !== null && current.type !== type) current = current.parent;
  return current;
}

const SELF_OBJECTS = new Set(["self", "cls"]);

/** Binding tables per tree: scope node id -> names, and class node id -> self attributes. */
interface TreeCaches {
  scopes: Map<number, BindingTable>;
  classAttributes: Map<number, BindingTable>;
}
// WeakMap keyed by the syntax tree (like C# ConditionalWeakTable): a freed tree frees its entries.
const treeCaches = new WeakMap<object, TreeCaches>();

function cachesFor(tree: object): TreeCaches {
  let caches = treeCaches.get(tree);
  if (caches === undefined) {
    caches = { scopes: new Map(), classAttributes: new Map() };
    treeCaches.set(tree, caches);
  }
  return caches;
}

function isSelfObject(attribute: SyntaxNode): boolean {
  const object = attribute.childForFieldName("object");
  return object !== null && object.type === "identifier" && SELF_OBJECTS.has(object.text);
}

function selfAttributeName(node: SyntaxNode | null): string | undefined {
  if (node === null || node.type !== "attribute" || !isSelfObject(node)) return undefined;
  return node.childForFieldName("attribute")?.text;
}

/**
 * Every binding of every `self.x` / class-level `x` of one class, in one linear walk.
 * `self.x = None` is ignored, so the usual "None first, set later" pattern still works.
 */
function collectClassAttributes(cls: SyntaxNode, root: SyntaxNode): BindingTable {
  const table: BindingTable = new Map();
  const body = cls.childForFieldName("body");
  if (body === null) return table;
  // Each entry carries its nearest enclosing function or class (the assignment's scope).
  const stack: { node: SyntaxNode; scope: SyntaxNode }[] = [{ node: body, scope: cls }];
  while (stack.length > 0) {
    const { node, scope } = stack.pop() as { node: SyntaxNode; scope: SyntaxNode };
    if (node.type === "class_definition") continue; // nested classes have their own attributes
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      if (left !== null && !isNoneValue(node.childForFieldName("right"))) {
        const fn = scope.type === "function_definition" ? scope : null;
        const viaSelf = selfAttributeName(left);
        if (viaSelf !== undefined) {
          addBinding(table, viaSelf, attributeValueHint(node, fn, root));
        } else if (left.type === "identifier" && scope.type === "class_definition") {
          addBinding(table, left.text, attributeValueHint(node, null, root));
        } else if (left.type !== "identifier" && left.type !== "attribute") {
          // Tuple unpacking into self.x: the class is unknown.
          for (const c of left.namedChildren) {
            const name = selfAttributeName(c);
            if (name !== undefined) addBinding(table, name, undefined);
          }
        }
      }
    } else if (node.type === "augmented_assignment") {
      const name = selfAttributeName(node.childForFieldName("left"));
      if (name !== undefined) addBinding(table, name, undefined);
    }
    const childScope = node.type === "function_definition" ? node : scope;
    for (const child of node.namedChildren) stack.push({ node: child, scope: childScope });
  }
  return table;
}

/** Type of `self.x` in `self.x.m()`: every assignment to `self.x` in the class must agree. */
function inferSelfAttributeType(ctx: ReceiverTypeContext): string | undefined {
  const receiver = ctx.receiverNode;
  const name = selfAttributeName(receiver);
  if (name === undefined) return undefined;
  const cls = enclosingOfType(receiver, "class_definition");
  if (cls === null) return undefined;
  const caches = cachesFor(cls.tree);
  let table = caches.classAttributes.get(cls.id);
  if (table === undefined) {
    table = collectClassAttributes(cls, ctx.root);
    caches.classAttributes.set(cls.id, table);
  }
  return unifiedHint(table.get(name) ?? []);
}

function collectBindings(scope: SyntaxNode, name: string): Binding[] {
  const caches = cachesFor(scope.tree);
  let table = caches.scopes.get(scope.id);
  if (table === undefined) {
    table = collectScopeBindings(scope);
    caches.scopes.set(scope.id, table);
  }
  return table.get(name) ?? [];
}

/** The innermost enclosing scope that binds `name`, walking out through nested functions. */
function bindingsFor(start: SyntaxNode | undefined, root: SyntaxNode, name: string): Binding[] {
  let scope: SyntaxNode | null = start ?? root;
  while (scope !== null) {
    const bindings = collectBindings(scope, name);
    if (bindings.length > 0) return bindings;
    if (scope.type === "module") return [];
    // Move to the next enclosing function (class bodies are not visible from methods).
    let parent: SyntaxNode | null = scope.parent;
    while (parent !== null && parent.type !== "function_definition" && parent.type !== "module") {
      parent = parent.parent;
    }
    scope = parent ?? root;
  }
  return [];
}

/**
 * Conservative same-scope type inference for `x.method()`. A hint is returned only when
 * every binding of `x` in the enclosing function (parameters, assignments, loops, `with`,
 * walrus) agrees on one class: `x = Foo(...)`, `x: Foo = ...`, `def f(x: Foo)`. Any other
 * binding of `x` (a different class, an unknown value) cancels the hint.
 */
export function inferPythonReceiverType(ctx: ReceiverTypeContext): string | undefined {
  // `Foo(...).run()`: the receiver is a constructor call.
  if (ctx.receiverNode.type === "call") return constructorHint(ctx.receiverNode);
  // `self.session.get()`: the type of an instance attribute.
  if (ctx.receiverNode.type === "attribute") return inferSelfAttributeType(ctx);
  if (ctx.receiverNode.type !== "identifier") return undefined;
  const name = ctx.receiverNode.text;
  const bindings = bindingsFor(ctx.enclosingDefinitionNode, ctx.root, name);
  if (bindings.length === 0) return undefined;
  const first = bindings[0]?.hint;
  if (first === undefined) return undefined;
  return bindings.every((b) => b.hint === first) ? first : undefined;
}

const GENERATOR_NAMES = new Set([
  "Iterator",
  "Generator",
  "Iterable",
  "AsyncIterator",
  "AsyncGenerator",
  "AsyncIterable",
]);

/** `-> Foo`, `-> Optional[Foo]`, and for generators `-> Iterator[Foo]` / `Generator[Foo, ...]`. */
function returnAnnotationHint(type: SyntaxNode): string | undefined {
  const inner =
    type.type === "type" && type.namedChildren.length === 1 ? type.namedChildren[0] : type;
  if (inner !== undefined && (inner.type === "subscript" || inner.type === "generic_type")) {
    const base =
      inner.type === "subscript"
        ? (inner.childForFieldName("value")?.text ?? "")
        : (inner.namedChildren[0]?.text ?? "");
    const name = base.replace(/\s+/g, "");
    if (GENERATOR_NAMES.has(name.slice(name.lastIndexOf(".") + 1))) {
      const args = inner.namedChildren
        .slice(1)
        .flatMap((c) => (c.type === "type_parameter" ? c.namedChildren : [c]));
      const first = args[0];
      return first === undefined ? undefined : annotationToTypeHint(first);
    }
  }
  return annotationToTypeHint(type);
}

/**
 * The one class a function returns: its `-> X` annotation, or else the class that every
 * `return`/`yield` of the body agrees on (`return Foo(...)`, `yield x` with `x = Foo()`).
 * Undefined when unknown. Used to type pytest fixtures and similar factories.
 */
export function inferReturnHint(fn: SyntaxNode, root: SyntaxNode): string | undefined {
  const annotated = fn.childForFieldName("return_type");
  if (annotated !== null) return returnAnnotationHint(annotated);
  const body = fn.childForFieldName("body");
  if (body === null) return undefined;
  const hints: (string | undefined)[] = [];
  const stack: SyntaxNode[] = [body];
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    if (SCOPE_BOUNDARIES.has(node.type)) continue;
    if (node.type === "return_statement" || node.type === "yield") {
      const value = node.namedChildren.find((c) => c.type !== "comment") ?? null;
      if (value !== null && !isNoneValue(value)) {
        const viaConstructor = constructorHint(value);
        if (viaConstructor !== undefined) hints.push(viaConstructor);
        else if (value.type === "identifier") {
          hints.push(unifiedHint(bindingsFor(fn, root, value.text)));
        } else hints.push(undefined);
      }
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  const first = hints[0];
  if (first === undefined) return undefined;
  return hints.every((h) => h === first) ? first : undefined;
}
