/** TypeScript and JavaScript source extensions handled by this plugin. */
const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const JS_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"];

export function isTypeScriptSource(path: string): boolean {
  if (path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts")) return false;
  return TS_EXTENSIONS.some((ext) => path.endsWith(ext));
}

export function isJavaScriptSource(path: string): boolean {
  return JS_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Everything the plugin claims: TypeScript plus JavaScript (CommonJS and ESM). */
export function isSupportedSource(path: string): boolean {
  return isTypeScriptSource(path) || isJavaScriptSource(path);
}

/** The language recorded on a file: "javascript" for .js/.jsx/.mjs/.cjs, else "typescript". */
export function languageOfSource(path: string): "typescript" | "javascript" {
  return isJavaScriptSource(path) ? "javascript" : "typescript";
}
