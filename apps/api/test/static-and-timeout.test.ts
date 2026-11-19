import { describe, expect, it } from "vitest";
import { get, makeRepoDir, makeTestApp, startAnalysis } from "./support.ts";

describe("web frontend serving", () => {
  it("serves index.html for unknown non-API GET routes, but API 404s stay JSON", async () => {
    const web = await makeRepoDir({
      "index.html": "<!doctype html><title>atlas</title>",
      "app.js": "1",
    });
    const t = await makeTestApp({ env: { WEB_DIST_DIR: web.dir } });
    try {
      const root = await get(t, "/");
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain("<title>atlas</title>");
      const deepLink = await get(t, "/analysis/an_123/map");
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.body).toContain("<title>atlas</title>");
      expect((await get(t, "/app.js")).statusCode).toBe(200);
      const api = await get(t, "/api/nope");
      expect(api.statusCode).toBe(404);
      expect(api.json().error.code).toBe("NOT_FOUND");
    } finally {
      await t.cleanup();
      await web.cleanup();
    }
  });
});

describe("analysis timeout", () => {
  it("fails the analysis with TIMEOUT when the wall-clock limit is exceeded", async () => {
    const t = await makeTestApp({ env: { ANALYSIS_TIMEOUT_MS: "5" } });
    try {
      t.fetcher.resolveImpl = async (req) => {
        await new Promise((r) => setTimeout(r, 40));
        return { commitSha: "c".repeat(40), ref: req.ref ?? "main" };
      };
      // POST itself is not limited by the analysis timeout; only the job is.
      const { json } = await startAnalysis(t);
      await t.jobs.idle();
      const body = (await get(t, `/api/analyses/${String(json.id)}`)).json();
      expect(body.status).toBe("failed");
      expect(body.error.code).toBe("TIMEOUT");
    } finally {
      await t.cleanup();
    }
  });
});
