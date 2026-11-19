import type { RepoView } from "@repoatlas/plugin-api";
import ts from "typescript";
import { toVirtualPath, VIRTUAL_ROOT } from "./virtual-host.ts";

/**
 * Applies RepoAtlas' fixed overrides on top of the options read from tsconfig.json
 * (LANGUAGE_PLUGINS section 6). Pure: easy to unit test.
 *
 * `raw` may be undefined when the repo has no (readable) tsconfig; sane defaults are used.
 */
export function applyCompilerOverrides(raw: ts.CompilerOptions | undefined): ts.CompilerOptions {
  // Spread copy: never mutate the caller's object (like `with { }` on a C# record).
  const options: ts.CompilerOptions = { ...raw };

  // Fixed by us: we only analyze, never emit or build.
  options.noEmit = true;
  options.skipLibCheck = true;
  options.allowJs = false; // JavaScript support arrives with the javascript language (M4)
  options.checkJs = false;
  options.composite = false;
  options.incremental = false;
  options.declaration = false;
  options.declarationMap = false;
  options.sourceMap = false;
  options.emitDeclarationOnly = false;
  options.noResolve = false;
  options.resolveJsonModule = true;
  options.allowImportingTsExtensions = true;
  options.types = []; // node_modules never exists, so no @types packages

  // Dropped: these could make the compiler load things from outside the repo view.
  delete options.plugins;
  delete options.typeRoots;
  delete options.outDir;
  delete options.outFile;
  delete options.rootDir;
  delete options.tsBuildInfoFile;
  delete options.declarationDir;

  // Defaults only when the project did not say anything.
  options.target ??= ts.ScriptTarget.ES2022;
  options.module ??= ts.ModuleKind.ESNext;
  options.moduleResolution ??= ts.ModuleResolutionKind.Bundler;
  options.jsx ??= ts.JsxEmit.Preserve;
  options.lib ??= ["lib.es2022.d.ts"];
  options.strict ??= false;

  // `paths` is resolved relative to this base when no baseUrl is given. TypeScript already
  // set it to the directory of the config file that declared `paths` (it can be an extended
  // config in a subdirectory), so only fill it in when missing.
  const withBase = options as Record<string, unknown>;
  withBase.pathsBasePath ??= VIRTUAL_ROOT;
  return options;
}

/** Reads tsconfig.json at the repo root through RepoView (never ts.sys). */
export function readTsconfigOptions(repo: RepoView): {
  options: ts.CompilerOptions;
  tsconfigPath: string | undefined;
} {
  const text = repo.readSync("tsconfig.json");
  if (text === undefined)
    return { options: applyCompilerOverrides(undefined), tsconfigPath: undefined };

  const parsedText = ts.parseConfigFileTextToJson("tsconfig.json", text);
  if (parsedText.config === undefined) {
    return { options: applyCompilerOverrides(undefined), tsconfigPath: "tsconfig.json" };
  }

  // A ParseConfigHost over RepoView so that "extends" chains resolve inside the repo only.
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: () => [], // we pick source files ourselves; only the options matter
    fileExists: (p) => {
      const rel = relOf(p);
      return rel !== undefined && repo.exists(rel) && !repo.isDir(rel);
    },
    readFile: (p) => {
      const rel = relOf(p);
      return rel === undefined ? undefined : repo.readSync(rel);
    },
  };
  const parsed = ts.parseJsonConfigFileContent(
    parsedText.config,
    host,
    VIRTUAL_ROOT,
    undefined,
    toVirtualPath("tsconfig.json"),
  );
  // parsed.errors (missing "extends" packages, empty include, ...) are deliberately ignored.
  return { options: applyCompilerOverrides(parsed.options), tsconfigPath: "tsconfig.json" };
}

function relOf(abs: string): string | undefined {
  if (abs === VIRTUAL_ROOT) return "";
  return abs.startsWith(`${VIRTUAL_ROOT}/`) ? abs.slice(VIRTUAL_ROOT.length + 1) : undefined;
}
