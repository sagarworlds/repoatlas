import { ANALYZER_VERSION, parseGitHubUrl } from "@repoatlas/core";
import type { AnalysisRecord } from "@repoatlas/store";
import { ulid } from "ulid";
import { z } from "zod";
import type { RouteContext, ZodApp } from "../context.ts";
import { apiError } from "../errors.ts";
import { AnalysisIdParams, toAnalysisJson } from "./helpers.ts";

/** How long POST /api/analyses may wait for GitHub to resolve the ref to a commit. */
const RESOLVE_TIMEOUT_MS = 30_000;

// Same rule as SECURITY.md section 2 for refs typed outside a URL.
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

const StartBody = z.object({
  repoUrl: z.string().min(1).max(500),
  ref: z
    .string()
    .regex(REF_RE, "invalid ref")
    .refine((r) => !r.includes("..") && r.split("/").every((s) => s !== "" && s !== "."), {
      message: "invalid ref",
    })
    .optional(),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function registerAnalysisRoutes(app: ZodApp, ctx: RouteContext): void {
  const { store, fetcher, jobs, config } = ctx;

  app.post(
    "/api/analyses",
    {
      schema: { body: StartBody },
      config: {
        rateLimit: {
          max: config.rateLimit.analysesMax,
          timeWindow: config.rateLimit.analysesWindowMs,
        },
      },
    },
    async (request, reply) => {
      // Throws AnalysisError(INVALID_REPO_URL) with a safe message when the input is bad.
      const parsed = parseGitHubUrl(request.body.repoUrl);
      const requestedRef = request.body.ref ?? parsed.ref;

      // One GitHub call resolves the ref to a commit SHA. GitHub problems (not found,
      // private, rate limited) surface here as HTTP errors, before anything is queued.
      const resolved = await fetcher.resolve(
        { owner: parsed.owner, repo: parsed.repo, ref: requestedRef },
        AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      );

      const cached = store.findCached(
        parsed.owner,
        parsed.repo,
        resolved.commitSha,
        ANALYZER_VERSION,
      );
      if (cached) {
        return reply.code(200).send({ ...startJson(cached), cached: true });
      }

      // Everything below is synchronous, so two requests cannot both pass this check.
      const inFlight = store.findInFlight(parsed.owner, parsed.repo, resolved.ref);
      if (inFlight) {
        return reply.code(202).send({ ...startJson(inFlight), cached: false });
      }

      const created = store.createAnalysis({
        id: `an_${ulid()}`,
        owner: parsed.owner,
        repo: parsed.repo,
        ref: resolved.ref,
        analyzerVersion: ANALYZER_VERSION,
      });
      // Recording the SHA now also protects its sources directory from eviction.
      store.updateAnalysis(created.id, { commitSha: resolved.commitSha });
      jobs.enqueue(created.id);

      // Report the state at creation time (the job may already have moved on to `fetching`).
      return reply
        .code(202)
        .send({ ...startJson(created), commitSha: resolved.commitSha, cached: false });
    },
  );

  app.get("/api/analyses", { schema: { querystring: ListQuery } }, async (request) => {
    const limit = request.query.limit ?? 20;
    return { analyses: store.listAnalyses(limit).map(toAnalysisJson) };
  });

  app.get("/api/analyses/:id", { schema: { params: AnalysisIdParams } }, async (request) => {
    const analysis = store.getAnalysis(request.params.id);
    if (!analysis) throw apiError("ANALYSIS_NOT_FOUND", "Analysis not found.");
    return toAnalysisJson(analysis);
  });
}

function startJson(record: AnalysisRecord) {
  return {
    id: record.id,
    status: record.status,
    owner: record.owner,
    repo: record.repo,
    ref: record.ref,
    commitSha: record.commitSha,
  };
}
