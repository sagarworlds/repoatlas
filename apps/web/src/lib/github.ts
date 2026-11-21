/**
 * https://github.com/{owner}/{repo}/blob/{sha}/{path}#L{a}-L{b}
 * Each path segment is URL-encoded; the slashes between segments are kept.
 */
export function buildGithubBlobUrl(
  owner: string,
  repo: string,
  sha: string,
  path: string,
  startLine?: number,
  endLine?: number,
): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  let url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(sha)}/${encodedPath}`;
  if (startLine !== undefined && startLine >= 1) {
    url += `#L${startLine}`;
    if (endLine !== undefined && endLine > startLine) url += `-L${endLine}`;
  }
  return url;
}
