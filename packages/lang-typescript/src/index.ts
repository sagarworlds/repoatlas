export type { TypeScriptProjectInfo } from "./analyze.ts";
export { analyzeTypeScriptProject, computeProjectInfo } from "./analyze.ts";
export { externalTargetFor, isNodeBuiltin, looksLikeNpmName } from "./module-names.ts";
export { typescriptPlugin } from "./plugin.ts";
export {
  isJavaScriptSource,
  isSupportedSource,
  isTypeScriptSource,
  languageOfSource,
} from "./source-kinds.ts";
export { applyCompilerOverrides, readTsconfigOptions } from "./tsconfig.ts";
export {
  buildWorkspacePackages,
  parsePackageJsonWorkspaces,
  parsePnpmWorkspaceGlobs,
  resolveWorkspaceImport,
  type WorkspacePackages,
} from "./workspaces.ts";
