import { createHash } from "node:crypto";
import type { LanguagePlugin } from "@repoatlas/plugin-api";
import { SCHEMA_VERSION } from "@repoatlas/schema";
import { ANALYZER_VERSION } from "./version.ts";

/** Bump when the key layout below changes (old rows then simply never match). */
const KEY_FORMAT = 1;

/** Everything that can change what `plugin.extract` returns for one file. */
export interface ExtractionKeyParts {
  analyzerVersion: string;
  schemaVersion: number;
  pluginId: string;
  pluginVersion: string;
  language: string;
  /** Repo-relative POSIX path. Part of the key because `FileExtraction.file` and the
   * plugins' local ids can contain it. */
  path: string;
  /** Hex sha256 of the file content (see `hashContent`). */
  contentHash: string;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Cache key: sha256 over the JSON array of all parts. JSON quoting makes the encoding
 * unambiguous (no "a|b" + "c" versus "a" + "b|c" collisions).
 *
 * The path is part of the key on purpose. A path-independent key would need every plugin to
 * keep paths out of its output; instead the key still hits across commits and forks of a
 * repository as long as a file keeps its path and content (the common case). A renamed or
 * moved file is one cheap miss.
 *
 * `plugin.prepare` info is NOT part of the key: the contract says `extract` is pure per file
 * and depends only on the file, so project-wide info (module roots, go.mod) is used by
 * `resolve` only. A plugin whose `extract` starts to depend on `info` must bump its version
 * and stop being cached, or fold the relevant bits into its version.
 */
export function extractionCacheKey(parts: ExtractionKeyParts): string {
  const material = JSON.stringify([
    KEY_FORMAT,
    parts.analyzerVersion,
    parts.schemaVersion,
    parts.pluginId,
    parts.pluginVersion,
    parts.language,
    parts.path,
    parts.contentHash,
  ]);
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** Key for one file of one plugin using the current analyzer and schema versions. */
export function extractionKeyForFile(
  plugin: Pick<LanguagePlugin, "id" | "version">,
  language: string,
  path: string,
  content: string,
): string {
  return extractionCacheKey({
    analyzerVersion: ANALYZER_VERSION,
    schemaVersion: SCHEMA_VERSION,
    pluginId: plugin.id,
    pluginVersion: plugin.version,
    language,
    path,
    contentHash: hashContent(content),
  });
}
