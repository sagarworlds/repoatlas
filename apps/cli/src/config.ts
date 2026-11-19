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
