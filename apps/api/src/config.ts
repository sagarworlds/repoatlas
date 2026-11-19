import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Limits } from "@repoatlas/core";
import { z } from "zod";

// Directory of this module. Never use process.cwd() (see docs/DEPLOYMENT.md).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/** Repo root in dev (apps/api/src -> ../../..). */
export const appRoot = path.resolve(moduleDir, "..", "..", "..");

// z.coerce.number() converts the env string to a number (env vars are always strings).
const intFromEnv = (def: number) => z.coerce.number().int().positive().default(def);

const ConfigSchema = z.object({
  PORT: intFromEnv(4000),
  HTTP_PLATFORM_PORT: z.coerce.number().int().positive().optional(),
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  GITHUB_TOKEN: z.string().optional(),
  ANALYSIS_CONCURRENCY: intFromEnv(2),
  MAX_TARBALL_BYTES: intFromEnv(209_715_200),
  MAX_FILES: intFromEnv(20_000),
  MAX_FILE_BYTES: intFromEnv(1_048_576),
  ANALYSIS_TIMEOUT_MS: intFromEnv(600_000),
  CACHE_MAX_ANALYSES: intFromEnv(200),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  // Number of trusted proxy hops ("1" = one IIS/ARR hop), "loopback", or "false"/"0" (off).
  // A plain "true" is rejected on purpose: it would trust a client-supplied leftmost
  // X-Forwarded-For entry and let clients dodge the rate limit.
  TRUST_PROXY: z.string().default("false"),
  RATE_LIMIT_ANALYSES_MAX: intFromEnv(10),
  RATE_LIMIT_ANALYSES_WINDOW_MS: intFromEnv(3_600_000),
  RATE_LIMIT_GENERAL_MAX: intFromEnv(300),
  RATE_LIMIT_GENERAL_WINDOW_MS: intFromEnv(60_000),
  WEB_DIST_DIR: z.string().optional(),
  EXIT_ON_STDIN_CLOSE: z.enum(["true", "false", "1", "0"]).optional(),
});

export type TrustProxy = false | number | "loopback";

/** Parses TRUST_PROXY: "false"/"0" -> false, "loopback", or a positive hop count. */
export function parseTrustProxy(value: string): TrustProxy {
  const v = value.trim().toLowerCase();
  if (v === "false" || v === "0") return false;
  if (v === "loopback") return "loopback";
  if (/^[1-9][0-9]?$/.test(v)) return Number(v);
  throw new Error(
    `Invalid TRUST_PROXY "${value}": use a hop count (e.g. 1), "loopback", or "false".`,
  );
}

export interface Config {
  /** HTTP_PLATFORM_PORT wins over PORT (IIS HttpPlatformHandler). */
  port: number;
  /** Bind to loopback only when running behind IIS. */
  host: string;
  dataDir: string;
  logLevel: string;
  githubToken: string | undefined;
  analysisConcurrency: number;
  maxTarballBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  analysisTimeoutMs: number;
  cacheMaxAnalyses: number;
  /** Single allowed browser origin for CORS. */
  corsOrigin: string;
  /** Fastify trustProxy value: false (off), a hop count, or "loopback". */
  trustProxy: TrustProxy;
  rateLimit: {
    analysesMax: number;
    analysesWindowMs: number;
    generalMax: number;
    generalWindowMs: number;
  };
  /** Built frontend (apps/web/dist). Served only if the directory exists. */
  webDistDir: string;
  /** Shut down when stdin closes (HttpPlatformHandler parent). Default: on behind IIS. */
  exitOnStdinClose: boolean;
}

/** Pure function: validates an env-like object. Easy to unit test. */
export function parseConfig(env: Record<string, string | undefined>, baseDir: string): Config {
  // Empty strings (e.g. "GITHUB_TOKEN=" in .env) count as unset.
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    cleaned[key] = value === "" ? undefined : value;
  }
  // z.parse validates and returns a typed object, or throws a ZodError.
  const raw = ConfigSchema.parse(cleaned);
  const behindIis = raw.HTTP_PLATFORM_PORT !== undefined;
  return {
    port: raw.HTTP_PLATFORM_PORT ?? raw.PORT,
    host: behindIis ? "127.0.0.1" : "0.0.0.0",
    dataDir: path.resolve(baseDir, raw.DATA_DIR),
    logLevel: raw.LOG_LEVEL,
    githubToken: raw.GITHUB_TOKEN,
    analysisConcurrency: raw.ANALYSIS_CONCURRENCY,
    maxTarballBytes: raw.MAX_TARBALL_BYTES,
    maxFiles: raw.MAX_FILES,
    maxFileBytes: raw.MAX_FILE_BYTES,
    analysisTimeoutMs: raw.ANALYSIS_TIMEOUT_MS,
    cacheMaxAnalyses: raw.CACHE_MAX_ANALYSES,
    corsOrigin: raw.CORS_ORIGIN,
    trustProxy: parseTrustProxy(raw.TRUST_PROXY),
    rateLimit: {
      analysesMax: raw.RATE_LIMIT_ANALYSES_MAX,
      analysesWindowMs: raw.RATE_LIMIT_ANALYSES_WINDOW_MS,
      generalMax: raw.RATE_LIMIT_GENERAL_MAX,
      generalWindowMs: raw.RATE_LIMIT_GENERAL_WINDOW_MS,
    },
    webDistDir: path.resolve(baseDir, raw.WEB_DIST_DIR ?? path.join("apps", "web", "dist")),
    exitOnStdinClose:
      raw.EXIT_ON_STDIN_CLOSE === undefined
        ? behindIis
        : raw.EXIT_ON_STDIN_CLOSE === "true" || raw.EXIT_ON_STDIN_CLOSE === "1",
  };
}

/** Loads `.env` from a path relative to this file (not cwd), then parses process.env. */
export function loadConfig(): Config {
  const envFile = path.join(appRoot, ".env");
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile); // built into Node 22; does not override existing vars
  }
  return parseConfig(process.env, appRoot);
}

/** The resource limits handed to the analysis pipeline. */
export function limitsFromConfig(config: Config): Limits {
  return {
    maxTarballBytes: config.maxTarballBytes,
    maxFiles: config.maxFiles,
    maxFileBytes: config.maxFileBytes,
    analysisTimeoutMs: config.analysisTimeoutMs,
  };
}
