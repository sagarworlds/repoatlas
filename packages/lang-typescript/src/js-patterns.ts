import ts from "typescript";

/**
 * Syntax-only recognition of the JavaScript idioms that have no declaration keyword:
 * CommonJS exports and prototype-based classes. Pure functions over the AST.
 *
 * The result is a discriminated union (a tagged union): `kind` tells which other fields exist,
 * like a C# abstract record with several sealed subtypes and a `switch` on the type.
 */
export type AssignmentTarget =
  /** `exports.name = ...` or `module.exports.name = ...` */
  | { kind: "export-member"; name: string }
  /** `module.exports = ...` */
  | { kind: "module-exports" }
  /** `Owner.prototype.name = ...` */
  | { kind: "prototype-member"; owner: string; name: string }
  /** `Owner.prototype = ...` */
  | { kind: "prototype"; owner: string }
  /** `Owner.name = ...` (a static member when `Owner` is a local function or class) */
  | { kind: "static-member"; owner: string; name: string };

function isIdentifierNamed(node: ts.Node, text: string): boolean {
  return ts.isIdentifier(node) && node.text === text;
}

/** `exports` or `module.exports` */
function isExportsObject(node: ts.Expression): boolean {
  if (isIdentifierNamed(node, "exports")) return true;
  return (
    ts.isPropertyAccessExpression(node) &&
    isIdentifierNamed(node.expression, "module") &&
    node.name.text === "exports"
  );
}

function isModuleExports(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    isIdentifierNamed(node.expression, "module") &&
    node.name.text === "exports"
  );
}

/** Classifies the left-hand side of an assignment statement; undefined for everything else. */
export function classifyAssignmentTarget(left: ts.Expression): AssignmentTarget | undefined {
  if (isModuleExports(left)) return { kind: "module-exports" };
  if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.name)) return undefined;
  const name = left.name.text;
  const target = left.expression;

  if (isExportsObject(target)) return { kind: "export-member", name };
  if (ts.isIdentifier(target)) {
    if (name === "prototype") return { kind: "prototype", owner: target.text };
    return { kind: "static-member", owner: target.text, name };
  }
  if (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.name.text === "prototype"
  ) {
    return { kind: "prototype-member", owner: target.expression.text, name };
  }
  return undefined;
}

/**
 * Local names a CommonJS module exports: `module.exports = a`, `module.exports = { a, b: c }`,
 * `exports.x = a`, `module.exports.x = a` (top-level statements only).
 */
export function collectCommonJsExportedNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st)) continue;
    const expr = st.expression;
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
      continue;
    }
    const target = classifyAssignmentTarget(expr.left);
    if (target?.kind === "export-member") {
      if (ts.isIdentifier(expr.right)) names.add(expr.right.text);
    } else if (target?.kind === "module-exports") {
      if (ts.isIdentifier(expr.right)) names.add(expr.right.text);
      else if (ts.isObjectLiteralExpression(expr.right)) {
        for (const prop of expr.right.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) names.add(prop.name.text);
          else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) {
            names.add(prop.initializer.text);
          }
        }
      }
    }
  }
  return names;
}
