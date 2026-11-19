import { AnalysisError } from "../errors.ts";

export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  /** Branch, tag or SHA from `/tree/{ref}`; absent for the default branch. */
  ref?: string;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
// Whitespace, control characters (incl. NUL), backslash, percent-encoding, query, fragment and
// "@" (userinfo) are never valid anywhere in an accepted input.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
const FORBIDDEN_ANYWHERE = /[\s\u0000-\u001f\u007f\\%?#@]/;

function invalid(reason: string): never {
  throw new AnalysisError("INVALID_REPO_URL", `Invalid GitHub repository URL: ${reason}`);
}

function checkRepo(name: string): string {
  if (name === "." || name === ".." || !REPO_RE.test(name)) invalid("bad repository name");
  return name;
}

function checkOwner(name: string): string {
  if (!OWNER_RE.test(name)) invalid("bad owner name");
  return name;
}

function checkRef(segments: string[]): string {
  // Every ref segment must be a real name: no empty, "." or ".." parts (".." anywhere is
  // rejected too, git forbids it in ref names).
  if (segments.some((s) => s === "" || s === "." || s.includes(".."))) invalid("bad ref");
  const ref = segments.join("/");
  if (!REF_RE.test(ref)) invalid("bad ref");
  return ref;
}

/**
 * Parse a user-supplied repository reference (docs/SECURITY.md section 2).
 *
 * Accepted:  `https://github.com/{owner}/{repo}[.git][/]`
 *            `https://github.com/{owner}/{repo}/tree/{ref}[/]`   (ref may contain slashes)
 *            `{owner}/{repo}` shorthand
 * Rejected (INVALID_REPO_URL): every other scheme (http, ssh, git@, file...), every other host
 * including `www.github.com` (we choose strictness: one canonical host), userinfo, ports,
 * query strings and fragments (rejected, not stripped), percent-encoding, backslashes,
 * whitespace/control characters, and any path shape other than the two above.
 * The result is only ever used to BUILD api.github.com URLs; the input is never fetched.
 */
export function parseGitHubUrl(input: string): ParsedGitHubUrl {
  const text = input.trim();
  if (text.length === 0 || text.length > 500) invalid("empty or too long");
  if (FORBIDDEN_ANYWHERE.test(text)) invalid("contains forbidden characters");

  // Shorthand: "owner/repo" or "owner/repo.git".
  if (!text.includes(":")) {
    const parts = text.split("/");
    if (parts.length !== 2) invalid("expected owner/repo");
    return buildResult(parts[0] ?? "", parts[1] ?? "", []);
  }

  // Full URL. The scheme must be exactly https and the authority exactly "github.com"
  // (checked on the raw text, because the URL class silently drops default ports, so
  // "github.com:443" would otherwise slip through).
  const match = /^https:\/\/([^/]*)(\/.*)?$/i.exec(text);
  if (match === null) invalid("only https://github.com URLs are accepted");
  const authority = match[1] ?? "";
  if (authority.toLowerCase() !== "github.com") invalid("host must be github.com");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return invalid("not a valid URL");
  }
  // Belt and braces: re-check what the WHATWG parser understood.
  if (url.protocol !== "https:" || url.hostname !== "github.com")
    invalid("host must be github.com");
  if (url.username !== "" || url.password !== "" || url.port !== "")
    invalid("no credentials or port");

  // Use the RAW path: URL.pathname would silently resolve ".." segments.
  let segments = (match[2] ?? "").split("/").slice(1);
  if (segments.length > 0 && segments[segments.length - 1] === "") segments = segments.slice(0, -1);
  const [owner, repo, ...rest] = segments;
  if (owner === undefined || repo === undefined) invalid("expected /owner/repo");
  return buildResult(owner, repo, rest);
}

function buildResult(ownerRaw: string, repoRaw: string, rest: string[]): ParsedGitHubUrl {
  let repoName = repoRaw;
  // ".git" suffix is only accepted when nothing follows the repo name.
  if (rest.length === 0 && repoName.length > 4 && repoName.endsWith(".git")) {
    repoName = repoName.slice(0, -4);
  }
  const owner = checkOwner(ownerRaw);
  const repo = checkRepo(repoName);
  if (rest.length === 0) return { owner, repo };
  if (rest[0] !== "tree" || rest.length < 2) invalid("only /tree/{ref} paths are supported");
  return { owner, repo, ref: checkRef(rest.slice(1)) };
}
