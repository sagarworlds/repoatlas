/**
 * Packages that are NOT bundled into dist/server.js and must exist in the production
 * node_modules:
 *  - better-sqlite3: native addon (.node binary), cannot be bundled.
 *  - typescript: the compiler API used by @repoatlas/lang-typescript. It is ~9 MB, reads its
 *    own lib.*.d.ts files from disk next to itself, so it must stay a real package folder.
 */
export const API_EXTERNALS = ["better-sqlite3", "typescript"] as const;
