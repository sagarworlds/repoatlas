import type { LanguagePlugin, RepoFile, SourceFile } from "@repoatlas/plugin-api";
import type { FileExtraction, RawReference } from "@repoatlas/schema";
import ts from "typescript";
import { analyzeTypeScriptProject, computeProjectInfo } from "./analyze.ts";
import { collectDefinitions } from "./definitions.ts";
import { collectImports } from "./imports.ts";
import { isSupportedSource, languageOfSource } from "./source-kinds.ts";

/** Syntax-only extraction of one file (no type information). Used by `extract`. */
async function extractSingleFile(file: SourceFile): Promise<FileExtraction> {
  const sf = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.ES2022, true);
  const { definitions, localIdByDecl } = collectDefinitions(sf, file.path);

  const references: RawReference[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      let from: string | undefined;
      for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
        const hit = localIdByDecl.get(p);
        if (hit) {
          from = hit.localId;
          break;
        }
      }
      const ref: RawReference = {
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        kind: "call",
        name: "",
        argCount: node.arguments.length,
      };
      if (ts.isIdentifier(expr)) ref.name = expr.text;
      else if (ts.isPropertyAccessExpression(expr)) {
        ref.name = expr.name.text;
        ref.receiver = expr.expression.getText(sf);
        ref.receiverKind =
          expr.expression.kind === ts.SyntaxKind.ThisKeyword
            ? "self"
            : expr.expression.kind === ts.SyntaxKind.SuperKeyword
              ? "super"
              : ts.isIdentifier(expr.expression)
                ? "identifier"
                : ts.isCallExpression(expr.expression)
                  ? "call"
                  : "member-chain";
      }
      if (ref.name !== "") {
        if (from !== undefined) ref.fromLocalId = from;
        references.push(ref);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // `parseDiagnostics` is an internal field of SourceFile (the parser's own syntax errors).
  const internal = sf as unknown as { parseDiagnostics?: readonly unknown[] };
  return {
    file: file.path,
    language: languageOfSource(file.path),
    definitions,
    imports: collectImports(sf).map((s) => s.raw),
    references,
    parseErrors: internal.parseDiagnostics?.length ?? 0,
  };
}

export const typescriptPlugin: LanguagePlugin = {
  id: "typescript",
  version: "1",
  languages: ["typescript", "javascript"],
  tier: 3,

  detect(files: RepoFile[]): RepoFile[] {
    return files.filter((f) => isSupportedSource(f.path));
  },

  async prepare(ctx) {
    // Manifests are read as data only: tsconfig.json, pnpm-workspace.yaml, package.json.
    return { ...computeProjectInfo(ctx.repo) };
  },

  extract: (file) => extractSingleFile(file),

  // Whole-project analysis does the resolving (see analyzeProject), so this has nothing to add.
  async resolve() {
    return { imports: [], edges: [], externals: [], unresolved: [] };
  },

  analyzeProject: analyzeTypeScriptProject,
};
