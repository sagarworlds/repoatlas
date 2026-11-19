/**
 * Pure file-filtering rules (SECURITY §4). Every check returns a reason string when the
 * file should be skipped, or `undefined` when it is fine. Reasons are used as counters in
 * the analysis stats, so they are short, stable identifiers.
 */

/** Directory names skipped at any depth (matched by name, not by path). */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "bin",
  "obj",
  "__pycache__",
  ".venv",
  "venv",
]);

export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "packages.lock.json",
  "gradle.lockfile",
]);

const GENERATED_SUFFIXES: readonly string[] = [
  ".min.js",
  ".min.mjs",
  ".min.css",
  ".bundle.js",
  ".pb.go",
  "_pb2.py",
  "_pb2_grpc.py",
  ".pb.cc",
  ".pb.h",
  ".designer.cs",
  ".g.cs",
  ".generated.ts",
];

export const BINARY_SNIFF_BYTES = 8000;
export const MAX_AVG_LINE_LENGTH = 300;
export const MAX_LINE_LENGTH = 10_000;
const MARKER_SCAN_LINES = 20;

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

/** Reason if a path looks generated (by name only), else undefined. `path` is POSIX. */
export function isGeneratedPath(path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  if (LOCKFILE_NAMES.has(base)) return "lockfile";
  const lower = base.toLowerCase();
  if (GENERATED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return "generated-path";
  return undefined;
}

/** Reason if the first bytes contain a NUL byte (binary file), else undefined. */
export function looksBinary(buffer: Uint8Array): string | undefined {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return "binary";
  }
  return undefined;
}

/** Reason if the text looks minified or machine-generated, else undefined. */
export function looksMinifiedOrGenerated(content: string): string | undefined {
  if (content.length === 0) return undefined;
  const lines = content.split("\n");
  let longest = 0;
  for (const line of lines) {
    if (line.length > longest) longest = line.length;
  }
  if (longest > MAX_LINE_LENGTH) return "minified";
  if (content.length / lines.length > MAX_AVG_LINE_LENGTH) return "minified";
  for (const line of lines.slice(0, MARKER_SCAN_LINES)) {
    if (line.includes("@generated") || line.includes("DO NOT EDIT")) return "generated-marker";
  }
  return undefined;
}
