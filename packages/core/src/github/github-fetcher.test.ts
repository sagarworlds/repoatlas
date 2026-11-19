import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisError } from "../errors.ts";
import { buildTar } from "../security/test-support/tar-builder.ts";
import type { Limits } from "../types.ts";
import { GitHubFetcher } from "./github-fetcher.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const LIMITS: Limits = {
  maxTarballBytes: 1_000_000,
  maxFiles: 100,
  maxFileBytes: 10_000,
  analysisTimeoutMs: 60_000,
};
const REQ = { owner: "octocat", repo: "hello" };

interface Call {
  url: string;
  authorization: string | null;
  redirect: string | undefined;
}
type Handler = (url: URL) => Response;

/** Fake fetch: records every call and routes by URL. No network. */
function fakeFetch(handler: Handler): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({
      url: url.href,
      authorization: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect,
    });
    return Promise.resolve(handler(url));
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const repoInfo = (over: Record<string, unknown> = {}): Response =>
  json({ private: false, default_branch: "main", size: 10, ...over });

function tarballBytes(): Buffer {
  return gzipSync(
    buildTar([
      { path: "octocat-hello-0123456/", type: "dir" },
      { path: "octocat-hello-0123456/README.md", content: "hi" },
      { path: "octocat-hello-0123456/src/a.ts", content: "export const a = 1;" },
      { path: "octocat-hello-0123456/link", type: "symlink", linkTarget: "/etc/passwd" },
    ]),
  );
}

/** Standard happy-path router; `over` can replace individual routes. */
function router(over: Partial<Record<"repo" | "commit" | "tarball", Handler>> = {}): Handler {
  return (url) => {
    if (url.hostname === "codeload.github.com") return new Response(new Uint8Array(tarballBytes()));
    if (url.pathname.includes("/tarball/")) {
      return (
        over.tarball?.(url) ??
        new Response(null, {
          status: 302,
          headers: { location: `https://codeload.github.com/octocat/hello/legacy.tar.gz/${SHA}` },
        })
      );
    }
    if (url.pathname.includes("/commits/")) return over.commit?.(url) ?? json({ sha: SHA });
    return over.repo?.(url) ?? repoInfo();
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AnalysisError);
    return (err as AnalysisError).code;
  }
  throw new Error("expected rejection");
}

let dest: string;
beforeEach(async () => {
  dest = await mkdtemp(path.join(tmpdir(), "repoatlas-gh-"));
});
afterEach(async () => {
  await rm(dest, { recursive: true, force: true });
});

describe("GitHubFetcher.resolve", () => {
  it("uses the default branch when no ref is given", async () => {
    const { impl, calls } = fakeFetch(router());
    const r = await new GitHubFetcher({ fetchImpl: impl }).resolve(REQ);
    expect(r).toEqual({ commitSha: SHA, ref: "main" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/octocat/hello",
      "https://api.github.com/repos/octocat/hello/commits/main",
    ]);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("encodes each ref segment and keeps slashes", async () => {
    const { impl, calls } = fakeFetch(router());
    await new GitHubFetcher({ fetchImpl: impl }).resolve({ ...REQ, ref: "feature/a b#c" });
    expect(calls[1]?.url).toBe(
      "https://api.github.com/repos/octocat/hello/commits/feature/a%20b%23c",
    );
  });

  it("maps 404 to REPO_NOT_FOUND", async () => {
    const { impl } = fakeFetch(router({ repo: () => json({ message: "Not Found" }, 404) }));
    expect(await code(new GitHubFetcher({ fetchImpl: impl }).resolve(REQ))).toBe("REPO_NOT_FOUND");
  });

  it("maps private: true to REPO_PRIVATE", async () => {
    const { impl } = fakeFetch(router({ repo: () => repoInfo({ private: true }) }));
    expect(await code(new GitHubFetcher({ fetchImpl: impl }).resolve(REQ))).toBe("REPO_PRIVATE");
  });

  it("maps 403 with exhausted rate limit and 429 to RATE_LIMITED", async () => {
    for (const res of [
      () => json({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" }),
      () => json({}, 403, { "retry-after": "30" }),
      () => json({}, 429),
    ]) {
      const { impl } = fakeFetch(router({ repo: res }));
      expect(await code(new GitHubFetcher({ fetchImpl: impl }).resolve(REQ))).toBe("RATE_LIMITED");
    }
  });

  it("maps other failures to INTERNAL without leaking the token", async () => {
    const { impl } = fakeFetch(router({ repo: () => json({}, 500) }));
    const fetcher = new GitHubFetcher({ fetchImpl: impl, token: "ghp_SECRET" });
    try {
      await fetcher.resolve(REQ);
      throw new Error("should fail");
    } catch (err) {
      expect((err as AnalysisError).code).toBe("INTERNAL");
      expect(String((err as Error).message)).not.toContain("ghp_SECRET");
    }
    const forbidden = fakeFetch(router({ repo: () => json({}, 403) }));
    expect(await code(new GitHubFetcher({ fetchImpl: forbidden.impl }).resolve(REQ))).toBe(
      "INTERNAL",
    );
  });

  it("maps invalid JSON shapes to INTERNAL", async () => {
    const { impl } = fakeFetch(router({ repo: () => json({ nope: true }) }));
    expect(await code(new GitHubFetcher({ fetchImpl: impl }).resolve(REQ))).toBe("INTERNAL");
    const bad = fakeFetch(router({ commit: () => json({ sha: "../../x" }) }));
    expect(await code(new GitHubFetcher({ fetchImpl: bad.impl }).resolve(REQ))).toBe("INTERNAL");
  });

  it("maps 404 and 422 on the commit lookup to REPO_NOT_FOUND mentioning the ref", async () => {
    for (const status of [404, 422]) {
      const { impl } = fakeFetch(router({ commit: () => json({}, status) }));
      try {
        await new GitHubFetcher({ fetchImpl: impl }).resolve({ ...REQ, ref: "nope" });
        throw new Error("should fail");
      } catch (err) {
        expect((err as AnalysisError).code).toBe("REPO_NOT_FOUND");
        expect((err as AnalysisError).message).toContain("nope");
      }
    }
  });

  it("maps network failures to INTERNAL and aborts to CANCELLED", async () => {
    const failing = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    expect(await code(new GitHubFetcher({ fetchImpl: failing }).resolve(REQ))).toBe("INTERNAL");
    const controller = new AbortController();
    controller.abort();
    const { impl } = fakeFetch(router());
    expect(await code(new GitHubFetcher({ fetchImpl: impl }).resolve(REQ, controller.signal))).toBe(
      "CANCELLED",
    );
  });
});

describe("GitHubFetcher.fetch", () => {
  it("downloads, follows the codeload redirect and extracts safely", async () => {
    const { impl, calls } = fakeFetch(router());
    const result = await new GitHubFetcher({ fetchImpl: impl }).fetch(REQ, dest, LIMITS);
    expect(result).toEqual({
      owner: "octocat",
      repo: "hello",
      ref: "main",
      commitSha: SHA,
      rootDir: dest,
      skippedFiles: [{ reason: "symlink", count: 1 }],
    });
    expect(await readFile(path.join(dest, "src", "a.ts"), "utf8")).toBe("export const a = 1;");
    expect(calls.at(-1)?.url).toBe(
      `https://codeload.github.com/octocat/hello/legacy.tar.gz/${SHA}`,
    );
    expect(calls.some((c) => c.url.endsWith(`/tarball/${SHA}`))).toBe(true);
  });

  it("rejects repositories whose reported size exceeds the limit before downloading", async () => {
    const { impl, calls } = fakeFetch(router({ repo: () => repoInfo({ size: 2000 }) })); // ~2 MB
    const fetcher = new GitHubFetcher({ fetchImpl: impl });
    expect(await code(fetcher.fetch(REQ, dest, LIMITS))).toBe("REPO_TOO_LARGE");
    expect(calls.some((c) => c.url.includes("/tarball/"))).toBe(false);
  });

  it("refuses redirects to hosts that are not allowed", async () => {
    for (const target of [
      "https://evil.example.com/x.tar.gz",
      "http://codeload.github.com/x.tar.gz",
      "https://codeload.github.com.evil.com/x.tar.gz",
      "https://user@codeload.github.com/x.tar.gz",
      "https://codeload.github.com:8443/x.tar.gz",
      "http://127.0.0.1/x",
    ]) {
      const { impl, calls } = fakeFetch(
        router({
          tarball: () => new Response(null, { status: 302, headers: { location: target } }),
        }),
      );
      const fetcher = new GitHubFetcher({ fetchImpl: impl, token: "ghp_SECRET" });
      expect(await code(fetcher.fetch(REQ, dest, LIMITS))).toBe("INTERNAL");
      // The disallowed target must never have been requested.
      expect(calls.some((c) => c.url === new URL(target).href)).toBe(false);
    }
  });

  it("sends the token only to the API host, never to codeload", async () => {
    const { impl, calls } = fakeFetch(router());
    await new GitHubFetcher({ fetchImpl: impl, token: "ghp_SECRET" }).fetch(REQ, dest, LIMITS);
    const api = calls.filter((c) => new URL(c.url).hostname === "api.github.com");
    const codeload = calls.filter((c) => new URL(c.url).hostname === "codeload.github.com");
    expect(api.length).toBeGreaterThan(0);
    expect(codeload.length).toBe(1);
    expect(api.every((c) => c.authorization === "Bearer ghp_SECRET")).toBe(true);
    expect(codeload[0]?.authorization).toBeNull();
  });

  it("sends no Authorization header without a token", async () => {
    const { impl, calls } = fakeFetch(router());
    await new GitHubFetcher({ fetchImpl: impl }).fetch(REQ, dest, LIMITS);
    expect(calls.every((c) => c.authorization === null)).toBe(true);
  });

  it("aborts with REPO_TOO_LARGE when compressed bytes exceed the limit", async () => {
    const { impl } = fakeFetch(router());
    const tiny: Limits = { ...LIMITS, maxTarballBytes: 100 };
    const fetcher = new GitHubFetcher({ fetchImpl: impl });
    expect(await code(fetcher.fetch(REQ, dest, tiny))).toBe("REPO_TOO_LARGE");
  });

  it("rejects early on an oversized Content-Length", async () => {
    const big = (url: URL): Response =>
      url.hostname === "codeload.github.com"
        ? new Response(new Uint8Array(tarballBytes()), {
            headers: { "content-length": "999999999" },
          })
        : router()(url);
    const { impl } = fakeFetch(big);
    expect(await code(new GitHubFetcher({ fetchImpl: impl }).fetch(REQ, dest, LIMITS))).toBe(
      "REPO_TOO_LARGE",
    );
  });

  it("maps a corrupt archive to INTERNAL", async () => {
    const { impl } = fakeFetch(
      router({ tarball: () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) }),
    );
    expect(await code(new GitHubFetcher({ fetchImpl: impl }).fetch(REQ, dest, LIMITS))).toBe(
      "INTERNAL",
    );
  });

  it("maps tarball 404 and rate limiting", async () => {
    const nf = fakeFetch(router({ tarball: () => new Response(null, { status: 404 }) }));
    expect(await code(new GitHubFetcher({ fetchImpl: nf.impl }).fetch(REQ, dest, LIMITS))).toBe(
      "REPO_NOT_FOUND",
    );
    const rl = fakeFetch(router({ tarball: () => new Response(null, { status: 429 }) }));
    expect(await code(new GitHubFetcher({ fetchImpl: rl.impl }).fetch(REQ, dest, LIMITS))).toBe(
      "RATE_LIMITED",
    );
  });

  it("honours a custom apiBase and follows same-origin redirects", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.pathname === "/repos/octocat/hello") return repoInfo();
      if (url.pathname.includes("/commits/")) return json({ sha: SHA });
      if (url.pathname.includes("/tarball/")) {
        return new Response(null, { status: 301, headers: { location: "/redirected/tarball" } });
      }
      return new Response(new Uint8Array(tarballBytes()));
    });
    const fetcher = new GitHubFetcher({
      fetchImpl: impl,
      apiBase: "http://localhost:9999",
      token: "t",
    });
    await fetcher.fetch(REQ, dest, LIMITS);
    expect(calls.at(-1)?.url).toBe("http://localhost:9999/redirected/tarball");
    expect(calls.at(-1)?.authorization).toBe("Bearer t"); // same origin as the API
  });
});
