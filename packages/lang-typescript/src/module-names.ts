import { externalId, npmPackageName } from "@repoatlas/schema";

/**
 * Node.js built-in module names (hand-written, not read from `node:module`, so the
 * output does not depend on the Node version that runs the analysis).
 */
const NODE_BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/** True for "fs", "node:fs", "fs/promises", "node:test", "path/posix", ... */
export function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  const first = specifier.split("/")[0] ?? specifier;
  return NODE_BUILTINS.has(first);
}

/** A loose check that a bare specifier can be an npm package name ("@/x" and "#x" cannot). */
export function looksLikeNpmName(specifier: string): boolean {
  return /^(@[a-zA-Z0-9][\w.~-]*\/)?[a-zA-Z0-9][\w.~-]*(\/|$)/.test(specifier);
}

export const NODE_BUILTINS_EXTERNAL_ID = externalId("node", "builtins");

export type ExternalTarget =
  | { kind: "builtin"; id: string; name: string; specifier: string }
  | { kind: "npm"; id: string; name: string };

/**
 * Classifies a specifier that did not resolve to a repo file. Returns undefined when it is
 * not something we can name (e.g. "@/alias" without a matching tsconfig path, "#internal",
 * "https://..."), so the caller records it as unresolved instead of inventing a package.
 */
export function externalTargetFor(specifier: string): ExternalTarget | undefined {
  if (isNodeBuiltin(specifier)) {
    return {
      kind: "builtin",
      id: NODE_BUILTINS_EXTERNAL_ID,
      name: "node builtins",
      specifier,
    };
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  if (!looksLikeNpmName(specifier)) return undefined;
  const name = npmPackageName(specifier);
  return { kind: "npm", id: externalId("npm", name), name };
}
