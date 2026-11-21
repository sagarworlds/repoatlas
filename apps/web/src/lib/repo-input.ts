// Client-side check of the repository field. It only gives quick feedback: the server
// (parseGitHubUrl in packages/core) is authoritative and its message is shown when it disagrees.

export type RepoInputResult =
  | { ok: true; owner: string; repo: string; repoUrl: string }
  | { ok: false; message: string };

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

const HELP = "Enter a GitHub repository like owner/repo or https://github.com/owner/repo.";

/** Accepts `owner/repo`, `github.com/owner/repo`, and full https URLs (optionally .git or /tree/...). */
export function parseRepoInput(raw: string): RepoInputResult {
  const text = raw.trim();
  if (text === "") return { ok: false, message: HELP };
  if (/\s/.test(text)) return { ok: false, message: "The repository must not contain spaces." };

  let path: string;
  let isUrl = false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith("git@")) {
    // Anything with a scheme must be a plain https github.com URL.
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, message: HELP };
    }
    if (url.protocol !== "https:") {
      return { ok: false, message: "Only https://github.com repositories are supported." };
    }
    if (!isGithubHost(url.hostname) || url.username !== "" || url.password !== "") {
      return { ok: false, message: "Only public github.com repositories are supported." };
    }
    path = url.pathname;
    isUrl = true;
  } else if (/^(www\.)?github\.com\//i.test(text)) {
    path = text.replace(/^(www\.)?github\.com/i, "");
    isUrl = true;
  } else {
    path = text;
  }

  const segments = path.split("/").filter((s, i) => !(i === 0 && s === ""));
  const [owner, rawRepo] = segments;
  if (owner === undefined || rawRepo === undefined) return { ok: false, message: HELP };
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!isUrl && segments.length !== 2) return { ok: false, message: HELP };
  if (!OWNER_RE.test(owner)) return { ok: false, message: "That owner name does not look valid." };
  if (!REPO_RE.test(repo) || repo === "." || repo === "..") {
    return { ok: false, message: "That repository name does not look valid." };
  }
  const repoUrl = isUrl ? text : `https://github.com/${owner}/${repo}`;
  return { ok: true, owner, repo, repoUrl };
}

function isGithubHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "github.com" || host === "www.github.com";
}

/** Returns an error message for an invalid optional ref, or undefined when it is fine. */
export function validateRef(raw: string): string | undefined {
  const ref = raw.trim();
  if (ref === "") return undefined;
  if (
    !REF_RE.test(ref) ||
    ref.includes("..") ||
    ref.split("/").some((s) => s === "" || s === ".")
  ) {
    return "Branch, tag or commit may only contain letters, digits, . _ - and /.";
  }
  return undefined;
}
