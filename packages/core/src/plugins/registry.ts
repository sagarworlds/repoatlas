import type { LanguagePlugin } from "@repoatlas/plugin-api";

export interface PluginRegistry {
  readonly plugins: readonly LanguagePlugin[];
  byId(id: string): LanguagePlugin | undefined;
}

/** Builds a registry; plugin order is the detection priority. Throws on duplicate ids. */
export function createRegistry(plugins: LanguagePlugin[]): PluginRegistry {
  const map = new Map<string, LanguagePlugin>();
  for (const plugin of plugins) {
    if (map.has(plugin.id)) throw new Error(`Duplicate language plugin id: ${plugin.id}`);
    map.set(plugin.id, plugin);
  }
  const frozen: readonly LanguagePlugin[] = [...plugins];
  return { plugins: frozen, byId: (id) => map.get(id) };
}
