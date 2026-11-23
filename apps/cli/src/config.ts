import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS, type Limits } from "@repoatlas/core";

/** The repo-root .env, located from this module (apps/cli/src -> repo root), never from cwd. */
export const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

/** Loads the repo-root .env into process.env if it exists. Existing variables win. */
export function loadDotEnv(): void {
  if (existsSync(ENV_FILE)) {
    process.loadEnvFile(ENV_FILE);
  }
}

/** Default extraction cache database: <repo root>/data/cli-cache.db (located from this module). */
export const DEFAULT_CLI_CACHE_FILE = fileURLToPath(
  new URL("../../../data/cli-cache.db", import.meta.url),
);

export class ConfigError extends Error {}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  // Number() rather than parseInt so "12abc" is rejected instead of read as 12.
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

/** Limits from DEFAULT_LIMITS, overridable by environment variables. */
export function limitsFromEnv(env: NodeJS.ProcessEnv): Limits {
  return {
    maxTarballBytes: positiveInt(env, "MAX_TARBALL_BYTES", DEFAULT_LIMITS.maxTarballBytes),
    maxFiles: positiveInt(env, "MAX_FILES", DEFAULT_LIMITS.maxFiles),
    maxFileBytes: positiveInt(env, "MAX_FILE_BYTES", DEFAULT_LIMITS.maxFileBytes),
    analysisTimeoutMs: positiveInt(env, "ANALYSIS_TIMEOUT_MS", DEFAULT_LIMITS.analysisTimeoutMs),
  };
}

/** EXTRACT_WORKERS (same variable as the API): undefined when unset, which means "auto". */
export function workersFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.EXTRACT_WORKERS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0 || value > 64) {
    throw new ConfigError(`EXTRACT_WORKERS must be an integer from 0 to 64 (got "${raw}")`);
  }
  return value;
}

/** Location and size caps of the extraction cache (same variables as the API). */
export function cacheSettingsFromEnv(env: NodeJS.ProcessEnv): {
  file: string;
  maxEntries: number;
  maxBytes: number;
} {
  const file = env.CLI_CACHE_FILE?.trim();
  return {
    file: file ? file : DEFAULT_CLI_CACHE_FILE,
    maxEntries: positiveInt(env, "CACHE_MAX_EXTRACTIONS", 200_000),
    maxBytes: positiveInt(env, "CACHE_MAX_EXTRACTION_BYTES", 524_288_000),
  };
}
