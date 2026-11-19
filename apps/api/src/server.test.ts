import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { buildServer } from "./server.ts";

describe("GET /api/health", () => {
  it("responds ok", async () => {
    const app = buildServer(parseConfig({ LOG_LEVEL: "silent" }, path.resolve("/base")));
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });
});
