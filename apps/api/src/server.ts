import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.ts";

export const API_VERSION = "0.0.0";
export const ANALYZER_VERSION = "0";

export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });

  app.get("/api/health", async () => ({
    ok: true,
    version: API_VERSION,
    analyzerVersion: ANALYZER_VERSION,
  }));

  return app;
}
