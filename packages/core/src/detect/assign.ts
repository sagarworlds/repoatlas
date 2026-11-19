import type { LanguagePlugin, RepoFile } from "@repoatlas/plugin-api";

export interface AssignmentResult {
  /** Keyed by plugin id. Every plugin gets an entry (possibly empty), in plugin order. */
  assignments: Map<string, RepoFile[]>;
  /** Plugins whose detect() threw; they are skipped. */
  errors: { plugin: string; message: string }[];
  /** Files no plugin claimed. */
  unclaimed: RepoFile[];
}

/**
 * Gives each file to the FIRST plugin that claims it. Later plugins only see files that
 * earlier ones left over. A throwing plugin is recorded in `errors` and skipped.
 */
export function assignFilesToPlugins(
  files: RepoFile[],
  plugins: readonly LanguagePlugin[],
): AssignmentResult {
  const assignments = new Map<string, RepoFile[]>();
  const errors: { plugin: string; message: string }[] = [];
  let remaining = files;

  for (const plugin of plugins) {
    let claimed: RepoFile[] = [];
    try {
      // Pass a copy so a plugin cannot reorder or mutate our list.
      claimed = plugin.detect([...remaining]);
    } catch (err) {
      errors.push({ plugin: plugin.id, message: err instanceof Error ? err.message : String(err) });
    }
    // Only accept files that were actually in the candidate list.
    const candidatePaths = new Set(remaining.map((f) => f.path));
    const accepted = claimed.filter((f) => candidatePaths.has(f.path));
    assignments.set(plugin.id, accepted);
    const taken = new Set(accepted.map((f) => f.path));
    remaining = remaining.filter((f) => !taken.has(f.path));
  }

  return { assignments, errors, unclaimed: remaining };
}
