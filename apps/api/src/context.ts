import type { IncomingMessage, ServerResponse } from "node:http";
import type { analyzeRepository, Fetcher } from "@repoatlas/core";
import type { GraphStore } from "@repoatlas/store";
import type { FastifyBaseLogger, FastifyInstance, RawServerDefault } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "./config.ts";
import type { AnalysisJobs } from "./jobs/manager.ts";

/** The plugin list type the pipeline expects (the api package does not depend on plugin-api). */
export type PluginList = Parameters<typeof analyzeRepository>[0]["plugins"];

/** Everything the server needs from the outside world. Tests inject fakes here. */
export interface ApiDeps {
  config: Config;
  store: GraphStore;
  fetcher: Fetcher;
  plugins: PluginList;
}

/** Dependencies handed to each route module. */
export interface RouteContext extends ApiDeps {
  jobs: AnalysisJobs;
}

/** A Fastify instance whose route schemas are zod schemas (typed request.query etc.). */
export type ZodApp = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;
