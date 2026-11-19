import { ANALYZER_VERSION } from "@repoatlas/core";
import type { ZodApp } from "../context.ts";

export const API_VERSION = "0.0.0";

export function registerHealthRoutes(app: ZodApp): void {
  app.get("/api/health", async () => ({
    ok: true,
    version: API_VERSION,
    analyzerVersion: ANALYZER_VERSION,
  }));
}
