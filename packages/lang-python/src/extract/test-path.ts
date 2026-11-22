import { looksLikeTestPath } from "@repoatlas/plugin-api";

/** Python test files: test_*.py, *_test.py, conftest.py, or any tests/ or test/ folder. */
export function isPythonTestPath(path: string): boolean {
  if (looksLikeTestPath(path)) return true;
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (/^test_.*\.pyi?$/.test(base) || /_test\.pyi?$/.test(base) || base === "conftest.py") {
    return true;
  }
  return segments.slice(0, -1).some((s) => s === "tests" || s === "test");
}
