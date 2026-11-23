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
  options.allowJs = true; // .js/.jsx/.mjs/.cjs files are analyzed too (CommonJS and ESM)
  options.checkJs = false; // never report type errors in JavaScript
  options.maxNodeModuleJsDepth = 0; // node_modules never exists, so never load JS from it
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

/**
 * Reads tsconfig.json at the repo root through RepoView (never ts.sys). A JavaScript-only
 * project may have a jsconfig.json instead; it is read the same way when no tsconfig exists.
 */
export function readTsconfigOptions(repo: RepoView): {
  options: ts.CompilerOptions;
  tsconfigPath: string | undefined;
} {
  for (const name of CONFIG_FILE_NAMES) {
    const text = repo.readSync(name);
    if (text !== undefined) return readConfigText(repo, name, text);
  }
  return { options: applyCompilerOverrides(undefined), tsconfigPath: undefined };
}

const CONFIG_FILE_NAMES = ["tsconfig.json", "jsconfig.json"];

function readConfigText(
  repo: RepoView,
  name: string,
  text: string,
): { options: ts.CompilerOptions; tsconfigPath: string } {
  const parsedText = ts.parseConfigFileTextToJson(name, text);
  if (parsedText.config === undefined) {
    return { options: applyCompilerOverrides(undefined), tsconfigPath: name };
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
    toVirtualPath(name),
  );
  // parsed.errors (missing "extends" packages, empty include, ...) are deliberately ignored.
  return { options: applyCompilerOverrides(parsed.options), tsconfigPath: name };
}

function relOf(abs: string): string | undefined {
  if (abs === VIRTUAL_ROOT) return "";
  return abs.startsWith(`${VIRTUAL_ROOT}/`) ? abs.slice(VIRTUAL_ROOT.length + 1) : undefined;
}
