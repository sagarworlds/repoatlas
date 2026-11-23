import { isPlainGroupId } from "./pom.ts";

/**
 * Never-throwing, regex-free line scanner for the dependency groups declared in a
 * `build.gradle` / `build.gradle.kts` file. It reads lines such as
 * `implementation "org.slf4j:slf4j-api:2.0.9"` or `api(group = "x", name = "y")` and keeps
 * the group part. Version catalogs and anything computed are ignored. Nothing is executed.
 */

const MAX_LINES = 20_000;
const MAX_LINE_CHARS = 2_000;

const CONFIGURATIONS: ReadonlySet<string> = new Set([
  "implementation",
  "api",
  "compileOnly",
  "runtimeOnly",
  "annotationProcessor",
  "testImplementation",
  "testCompileOnly",
  "testRuntimeOnly",
  "testAnnotationProcessor",
  "compile",
  "testCompile",
  "runtime",
  "provided",
  "providedCompile",
  "kapt",
]);

function isWordChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9");
}

/** The first word of a line (letters and digits). */
function firstWord(line: string): string {
  let end = 0;
  while (end < line.length && isWordChar(line.charAt(end))) end++;
  return line.slice(0, end);
}

/** Contents of every single- or double-quoted string in `text`. */
function quotedStrings(text: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch !== '"' && ch !== "'") {
      i++;
      continue;
    }
    const close = text.indexOf(ch, i + 1);
    if (close < 0) break;
    found.push(text.slice(i + 1, close));
    i = close + 1;
  }
  return found;
}

/** `group: "x"` / `group = "x"` form: the quoted value after the word `group`. */
function namedGroup(text: string): string | undefined {
  const at = text.indexOf("group");
  if (at < 0) return undefined;
  let i = at + "group".length;
  while (text.charAt(i) === " ") i++;
  if (text.charAt(i) !== ":" && text.charAt(i) !== "=") return undefined;
  i++;
  while (text.charAt(i) === " ") i++;
  const quote = text.charAt(i);
  if (quote !== '"' && quote !== "'") return undefined;
  const close = text.indexOf(quote, i + 1);
  return close < 0 ? undefined : text.slice(i + 1, close);
}

/** Sorted, de-duplicated dependency groups of a Gradle build script. */
export function gradleDependencyGroups(script: string): string[] {
  const groups = new Set<string>();
  try {
    const lines = script.split("\n", MAX_LINES);
    for (const rawLine of lines) {
      const line = rawLine.trim().slice(0, MAX_LINE_CHARS);
      if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
      if (!CONFIGURATIONS.has(firstWord(line))) continue;
      for (const text of quotedStrings(line)) {
        const colon = text.indexOf(":");
        if (colon <= 0 || colon === text.length - 1) continue;
        const group = text.slice(0, colon);
        if (isPlainGroupId(group)) groups.add(group);
      }
      const named = namedGroup(line);
      if (named !== undefined && isPlainGroupId(named)) groups.add(named);
    }
  } catch {
    // Keep what was found.
  }
  return [...groups].sort();
}
