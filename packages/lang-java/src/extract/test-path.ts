import { looksLikeTestPath } from "@repoatlas/plugin-api";

const TEST_NAME_SUFFIXES = ["TestCase", "Tests", "Test", "IT"];

/** True for `UserServiceTest`, `UserTests`, `UserServiceIT`, `BaseTestCase` (not `Test` alone). */
export function isJavaTestClassName(name: string): boolean {
  return TEST_NAME_SUFFIXES.some((s) => name.length > s.length && name.endsWith(s));
}

/** Test annotations that make a method a test or a test fixture (JUnit 4 and 5, TestNG). */
export function isJavaTestAnnotation(annotation: string): boolean {
  const last = annotation.slice(annotation.lastIndexOf(".") + 1);
  return (
    last === "Test" ||
    last === "ParameterizedTest" ||
    last === "RepeatedTest" ||
    last === "TestFactory" ||
    last === "TestTemplate" ||
    last.startsWith("Before") ||
    last.startsWith("After")
  );
}

/** Test files: under a test/ or tests/ folder (src/test/java too), or named like a test class. */
export function isJavaTestPath(path: string): boolean {
  if (looksLikeTestPath(path)) return true;
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((s) => s === "test" || s === "tests")) return true;
  return base.endsWith(".java") && isJavaTestClassName(base.slice(0, -".java".length));
}
