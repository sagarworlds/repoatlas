import { existsSync } from "node:fs";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { ApiDeps, RouteContext } from "./context.ts";
import { ApiError, errorBody, mapError } from "./errors.ts";
import { type AnalysisJobs, createAnalysisJobs } from "./jobs/manager.ts";
import { registerAnalysisRoutes } from "./routes/analyses.ts";
import { registerGraphRoutes } from "./routes/graph.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerSourceRoutes } from "./routes/source.ts";

export { API_VERSION } from "./routes/health.ts";

export interface ApiServer {
  app: FastifyInstance;
  jobs: AnalysisJobs;
}

/**
 * Builds the Fastify app. Everything external (config, store, fetcher, plugins) is passed
 * in, so tests can use an in-memory store and a LocalDirFetcher. Does not listen.
 */
export async function buildServer(deps: ApiDeps): Promise<ApiServer> {
  const { config } = deps;
  // A hop count N means "trust the N nearest hops". Fastify supports a number at runtime
  // but its typings do not, so express it as the equivalent trust function (hop 0 is the
  // socket peer, i.e. the proxy itself).
  const hops = config.trustProxy;
  const trustProxy =
    typeof hops === "number" ? (_address: string, hop: number) => hop < hops : hops;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Defence in depth: credentials never appear in logs.
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    trustProxy,
  });

  // fastify-type-provider-zod: validate with zod schemas, infer handler types from them.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((err, request, reply) => {
    const mapped = mapError(err);
    if (mapped.unexpected) request.log.error({ err }, "unhandled error");
    return reply.code(mapped.statusCode).send(errorBody(mapped.code, mapped.message));
  });

  const serveWeb = existsSync(config.webDistDir);
  app.setNotFoundHandler(async (request, reply) => {
    const isApi = request.url === "/api" || request.url.startsWith("/api/");
    if (serveWeb && request.method === "GET" && !isApi) {
      return reply.type("text/html").sendFile("index.html"); // SPA fallback
    }
    return reply.code(404).send(errorBody("NOT_FOUND", "Route not found."));
  });

  await app.register(helmet);
  await app.register(cors, { origin: config.corsOrigin, methods: ["GET", "POST"] });
  await app.register(rateLimit, {
    max: config.rateLimit.generalMax,
    timeWindow: config.rateLimit.generalWindowMs,
    errorResponseBuilder: () =>
      new ApiError("RATE_LIMITED", 429, "Too many requests. Try again later."),
  });
  if (serveWeb) {
    // wildcard: false registers one route per built file; unknown paths reach the
    // not-found handler above (SPA fallback) instead of a static 404.
    await app.register(fastifyStatic, { root: config.webDistDir, wildcard: false });
  }

  const jobs = createAnalysisJobs(deps, app.log);
  const ctx: RouteContext = { ...deps, jobs };
  const zapp = app.withTypeProvider<ZodTypeProvider>();
  registerHealthRoutes(zapp);
  registerAnalysisRoutes(zapp, ctx);
  registerGraphRoutes(zapp, ctx);
  registerSourceRoutes(zapp, ctx);

  return { app, jobs };
}
