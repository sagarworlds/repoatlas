import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAnalysis, mockFetch } from "../test/utils.tsx";
import { filterCallflowByConfidence } from "./callflow-filter.ts";
import {
  ApiError,
  buildQuery,
  createAnalysis,
  fetchAnalysis,
  fetchGraph,
  parseErrorBody,
} from "./client.ts";
import type { CallflowResponse } from "./types.ts";

afterEach(() => vi.unstubAllGlobals());

describe("buildQuery", () => {
  it("encodes values and skips undefined", () => {
    expect(buildQuery({ a: "x y", b: undefined, c: 2, d: false })).toBe("?a=x+y&c=2&d=false");
    expect(buildQuery({})).toBe("");
  });
});

describe("parseErrorBody", () => {
  it("reads the single error shape and rejects others", () => {
    expect(parseErrorBody({ error: { code: "X", message: "m" } })).toEqual({
      code: "X",
      message: "m",
    });
    expect(parseErrorBody({ error: "nope" })).toBeUndefined();
    expect(parseErrorBody(null)).toBeUndefined();
  });
});

describe("api client", () => {
  it("throws ApiError with code, message and status", async () => {
    mockFetch(() => ({
      status: 403,
      body: { error: { code: "REPO_PRIVATE", message: "Private repo." } },
    }));
    const error = await createAnalysis({ repoUrl: "https://github.com/a/b" }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "REPO_PRIVATE", message: "Private repo.", status: 403 });
  });

  it("maps a non-JSON failure to BAD_RESPONSE and a network failure to NETWORK_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })),
    );
    await expect(fetchAnalysis("an_1")).rejects.toMatchObject({
      code: "BAD_RESPONSE",
      status: 502,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("failed to fetch");
      }),
    );
    await expect(fetchAnalysis("an_1")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("validates the analysis record", async () => {
    mockFetch(() => ({ status: 200, body: { id: "an_1", status: "bogus" } }));
    await expect(fetchAnalysis("an_1")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    mockFetch(() => ({ status: 200, body: makeAnalysis({ status: "parsing" }) }));
    await expect(fetchAnalysis("an_1")).resolves.toMatchObject({ status: "parsing" });
  });

  it("sends graph params with the server's names", async () => {
    const fetchMock = mockFetch(() => ({
      status: 200,
      body: { nodes: [], edges: [], truncated: false },
    }));
    await fetchGraph("an_1", {
      level: "file",
      root: "dir:src",
      depth: 3,
      edgeKinds: ["imports", "calls"],
      includeTests: true,
      includeExternal: false,
      minConfidence: "inferred",
    });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/analyses/an_1/graph?");
    expect(url).toContain("root=dir%3Asrc");
    expect(url).toContain("edgeKinds=imports%2Ccalls");
    expect(url).toContain("includeTests=true");
  });
});

describe("filterCallflowByConfidence", () => {
  const node = (id: string) => ({ id, kind: "function" as const, name: id });
  const data: CallflowResponse = {
    focus: "f",
    nodes: [node("f"), node("callee"), node("weak"), node("caller")],
    edges: [
      { src: "f", dst: "callee", kind: "calls", confidence: "exact" },
      { src: "f", dst: "weak", kind: "calls", confidence: "name-match" },
      { src: "caller", dst: "f", kind: "calls", confidence: "inferred" },
    ],
  };

  it("keeps everything at name-match", () => {
    expect(filterCallflowByConfidence(data, "name-match")).toBe(data);
  });

  it("drops weak edges and the nodes only they reach", () => {
    const result = filterCallflowByConfidence(data, "inferred");
    expect(result.nodes.map((n) => n.id).sort()).toEqual(["callee", "caller", "f"]);
    expect(result.edges).toHaveLength(2);
    const exact = filterCallflowByConfidence(data, "exact");
    expect(exact.nodes.map((n) => n.id).sort()).toEqual(["callee", "f"]);
  });
});
