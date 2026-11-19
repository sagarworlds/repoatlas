import { describe, expect, it } from "vitest";
import { AnalysisError } from "../errors.ts";
import { parseGitHubUrl } from "./url.ts";

function expectInvalid(input: string): void {
  try {
    parseGitHubUrl(input);
  } catch (err) {
    expect(err).toBeInstanceOf(AnalysisError);
    expect((err as AnalysisError).code).toBe("INVALID_REPO_URL");
    return;
  }
  throw new Error(`expected INVALID_REPO_URL for ${JSON.stringify(input)}`);
}

describe("parseGitHubUrl: accepted forms", () => {
  it.each([
    ["https://github.com/octocat/hello-world", { owner: "octocat", repo: "hello-world" }],
    ["https://github.com/octocat/hello-world/", { owner: "octocat", repo: "hello-world" }],
    ["https://github.com/octocat/hello-world.git", { owner: "octocat", repo: "hello-world" }],
    ["  https://github.com/octocat/hello-world  ", { owner: "octocat", repo: "hello-world" }],
    ["HTTPS://GITHUB.COM/octocat/hello-world", { owner: "octocat", repo: "hello-world" }],
    ["octocat/hello-world", { owner: "octocat", repo: "hello-world" }],
    ["octocat/hello-world.git", { owner: "octocat", repo: "hello-world" }],
    ["octocat/.github", { owner: "octocat", repo: ".github" }],
    ["octocat/a.b_c-d", { owner: "octocat", repo: "a.b_c-d" }],
    ["https://github.com/o/r/tree/main", { owner: "o", repo: "r", ref: "main" }],
    ["https://github.com/o/r/tree/main/", { owner: "o", repo: "r", ref: "main" }],
    ["https://github.com/o/r/tree/feature/x/y", { owner: "o", repo: "r", ref: "feature/x/y" }],
    ["https://github.com/o/r/tree/v1.2.3", { owner: "o", repo: "r", ref: "v1.2.3" }],
    [
      "https://github.com/o/r/tree/0123456789abcdef0123456789abcdef01234567",
      { owner: "o", repo: "r", ref: "0123456789abcdef0123456789abcdef01234567" },
    ],
  ])("accepts %s", (input, expected) => {
    expect(parseGitHubUrl(input)).toEqual(expected);
  });

  it("treats a .git suffix before /tree as part of the repo name", () => {
    expect(parseGitHubUrl("https://github.com/o/r.git/tree/main")).toEqual({
      owner: "o",
      repo: "r.git",
      ref: "main",
    });
  });

  it("omits ref when absent", () => {
    expect("ref" in parseGitHubUrl("o/r")).toBe(false);
  });
});

describe("parseGitHubUrl: SSRF and scheme/host attacks", () => {
  it.each([
    "http://github.com/o/r",
    "git@github.com:o/r.git",
    "ssh://git@github.com/o/r",
    "git://github.com/o/r",
    "file:///etc/passwd",
    "file://github.com/o/r",
    "ftp://github.com/o/r",
    "javascript:alert(1)",
    "//github.com/o/r",
    "github.com/o/r",
    "https://github.com.evil.com/o/r",
    "https://evil.com/github.com/o/r",
    "https://github.com@evil.com/o/r",
    "https://user@github.com/o/r",
    "https://user:pass@github.com/o/r",
    "https://evil.com@github.com/o/r",
    "https://github.com:443/o/r",
    "https://github.com:8080/o/r",
    "https://github.com./o/r",
    "https://www.github.com/o/r",
    "https://api.github.com/repos/o/r",
    "https://codeload.github.com/o/r/tar.gz/main",
    "https://raw.githubusercontent.com/o/r/main/x",
    "https://gist.github.com/o/r",
    "https://127.0.0.1/o/r",
    "https://localhost/o/r",
    "https://[::1]/o/r",
    "https://github.com\\@evil.com/o/r",
    "https://github.com\\.evil.com/o/r",
    "https:/github.com/o/r",
    "https:github.com/o/r",
    "https://",
    "https://github.com",
    "https://github.com/",
    "https://github.com/o",
  ])("rejects %s", (input) => {
    expectInvalid(input);
  });
});

describe("parseGitHubUrl: path traversal and encoding", () => {
  it.each([
    "https://github.com/%2e%2e/r",
    "https://github.com/o/%2e%2e",
    "https://github.com/o/r/tree/%2e%2e/etc",
    "https://github.com/o/r/tree/a%2Fb",
    "https://github.com/o%2Fx/r",
    "https://github.com/o/r%00",
    "https://github.com/o/r/tree/..",
    "https://github.com/o/r/tree/../x",
    "https://github.com/o/r/tree/a/../b",
    "https://github.com/o/r/tree/a/./b",
    "https://github.com/o/r/tree/a..b",
    "https://github.com/o/r/tree/a//b",
    "https://github.com/o/r/tree/",
    "https://github.com/o/r/tree",
    "https://github.com/../r",
    "https://github.com/o/..",
    "https://github.com/o/.",
    "https://github.com/o/r/../x",
    "https://github.com/o/r//",
    "https://github.com//o/r",
    "../etc/passwd",
    "o/..",
    "o/.",
    "./r",
    "o/r/extra",
    "o/r/tree/main",
    "/o/r",
    "o/",
    "/r",
    "o//r",
  ])("rejects %s", (input) => {
    expectInvalid(input);
  });
});

describe("parseGitHubUrl: unsupported path shapes, queries and fragments", () => {
  it.each([
    "https://github.com/o/r/blob/main/README.md",
    "https://github.com/o/r/pull/1",
    "https://github.com/o/r/issues",
    "https://github.com/o/r/releases/tag/v1",
    "https://github.com/o/r?tab=readme",
    "https://github.com/o/r?",
    "https://github.com/o/r#readme",
    "https://github.com/o/r#",
    "https://github.com/o/r/tree/main?x=1",
    "https://github.com/o/r/tree/main#frag",
  ])("rejects %s", (input) => {
    expectInvalid(input);
  });
});

describe("parseGitHubUrl: character and length validation", () => {
  it.each([
    "",
    "   ",
    "o /r",
    "o/r s",
    "o/r\tx",
    "o/r\u0000",
    "o\u0000/r",
    "o/r\u007f",
    "o\\r",
    "o/r\\x",
    "-o/r", // owner must start alphanumeric
    "o_x/r", // underscore not allowed in owner
    "o.x/r",
    `${"a".repeat(40)}/r`, // owner too long (max 39)
    `o/${"r".repeat(101)}`, // repo too long
    "o/r$",
    "o/r;ls",
    "o/r`x`",
    "o/r|x",
    "o/r&x",
    "o/r<x>",
    "o/r'x",
    'o/r"x',
    "o/r:x",
    "https://github.com/o/r/tree/ünï",
    `https://github.com/o/r/tree/${"a".repeat(201)}`,
    `https://github.com/${"a".repeat(600)}/r`,
    "https://github.com/o/r/tree/a b",
    "https://github.com/o/r/tree/a%20b",
    "https://github.com/o/r/tree/a\\b",
    "https://github.com/o/r/tree/a@{1}",
    "https://github.com/o/r/tree/a~1",
    "https://github.com/o/r/tree/a^",
    "https://github.com/o/r/tree/a*",
    "https://github.com/o/r/tree/a:b",
  ])("rejects %j", (input) => {
    expectInvalid(input);
  });

  it("accepts owner of 39 chars and repo of 100 chars, rejects 40/101", () => {
    expect(parseGitHubUrl(`${"a".repeat(39)}/${"r".repeat(100)}`).owner).toHaveLength(39);
    expectInvalid(`${"a".repeat(40)}/r`);
    expectInvalid(`o/${"r".repeat(101)}`);
  });

  it("accepts a ref of 200 chars, rejects 201", () => {
    const ok = parseGitHubUrl(`https://github.com/o/r/tree/${"a".repeat(200)}`);
    expect(ok.ref).toHaveLength(200);
    expectInvalid(`https://github.com/o/r/tree/${"a".repeat(201)}`);
  });

  it("rejects non-string-like junk without throwing other error types", () => {
    for (const junk of ["\ud800", "https://github.com/\ud800/r", "😀/r"]) expectInvalid(junk);
  });
});
