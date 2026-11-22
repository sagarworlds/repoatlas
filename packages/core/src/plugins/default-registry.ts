import { pythonPlugin } from "@repoatlas/lang-python";
import { typescriptPlugin } from "@repoatlas/lang-typescript";
import { createRegistry, type PluginRegistry } from "./registry.ts";

/** The plugins shipped with RepoAtlas. Add new `lang-*` plugins here (order = priority). */
export function createDefaultRegistry(): PluginRegistry {
  return createRegistry([typescriptPlugin, pythonPlugin]);
}
