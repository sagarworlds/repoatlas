import type { PluginProjectInfo, ProjectContext } from "@repoatlas/plugin-api";
import { toPosixPath } from "@repoatlas/schema";
import { gradleDependencyGroups } from "./gradle.ts";
import { pomDependencyGroups } from "./pom.ts";

export { gradleDependencyGroups } from "./gradle.ts";
export { isPlainGroupId, pomDependencyGroups } from "./pom.ts";

/**
 * What `javaPrepare` learns. Plain JSON (it is stored and passed between threads).
 * Java resolves by fully qualified name, so no source roots are needed; the only project
 * knowledge is the Maven/Gradle groupIds, used to name external packages.
 */
export type JavaProjectInfo = {
  /** Sorted, unique groupIds declared as dependencies in pom.xml / build.gradle(.kts). */
  dependencyGroups: string[];
  /** Repo-relative manifests that were read, shallowest first. */
  manifests: string[];
};

const MANIFEST_NAMES: ReadonlySet<string> = new Set([
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);
const MAX_MANIFESTS = 100;
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_GROUPS = 2_000;

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function manifestPaths(ctx: ProjectContext): string[] {
  const found = new Set<string>();
  for (const name of MANIFEST_NAMES) if (ctx.repo.exists(name)) found.add(name);
  for (const file of ctx.allFiles) {
    const path = toPosixPath(file.path);
    if (MANIFEST_NAMES.has(baseName(path)) && file.bytes <= MAX_MANIFEST_BYTES) found.add(path);
  }
  return [...found]
    .sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_MANIFESTS);
}

/**
 * Plugin `prepare` step. Reads pom.xml and Gradle build scripts through `ctx.repo` only,
 * for the declared dependency groupIds. Never throws: unreadable or odd manifests are
 * skipped, and the result is then simply empty.
 */
export async function javaPrepare(ctx: ProjectContext): Promise<JavaProjectInfo> {
  const groups = new Set<string>();
  const manifests: string[] = [];
  try {
    for (const path of manifestPaths(ctx)) {
      let text: string | undefined;
      try {
        text = await ctx.repo.read(path);
      } catch {
        continue;
      }
      if (text === undefined || text.length > MAX_MANIFEST_BYTES) continue;
      manifests.push(path);
      const found =
        baseName(path) === "pom.xml" ? pomDependencyGroups(text) : gradleDependencyGroups(text);
      for (const group of found) groups.add(group);
    }
  } catch {
    // A broken RepoView must not fail the analysis.
  }
  return { dependencyGroups: [...groups].sort().slice(0, MAX_GROUPS), manifests };
}

/** Reads a `JavaProjectInfo` back from the untyped `info` that core hands to `resolve`. */
export function readJavaProjectInfo(info: PluginProjectInfo | undefined): JavaProjectInfo {
  const raw = info?.["dependencyGroups"];
  const dependencyGroups = Array.isArray(raw)
    ? raw.filter((g): g is string => typeof g === "string")
    : [];
  const rawManifests = info?.["manifests"];
  const manifests = Array.isArray(rawManifests)
    ? rawManifests.filter((m): m is string => typeof m === "string")
    : [];
  return { dependencyGroups, manifests };
}
