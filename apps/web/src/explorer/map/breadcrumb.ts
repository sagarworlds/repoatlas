// Breadcrumb from the repository root down to the map root (pure, built from the id alone).
import { pathOfId } from "./graph-model.ts";

export interface Crumb {
  /** Node id to use as the new root when the crumb is clicked. */
  id: string;
  label: string;
}

/**
 * "dir:" -> [repo]; "dir:a/b" -> [repo, a, a/b]. For a file root ("file:a/b.ts") the last
 * crumb is the file and the earlier ones are its directories. Unknown ids give just [repo].
 */
export function buildBreadcrumb(rootId: string, repoLabel: string): Crumb[] {
  const crumbs: Crumb[] = [{ id: "dir:", label: repoLabel }];
  const path = pathOfId(rootId);
  if (path === "") return crumbs;
  const segments = path.split("/");
  const isFile = rootId.startsWith("file:");
  let prefix = "";
  segments.forEach((segment, index) => {
    prefix = index === 0 ? segment : `${prefix}/${segment}`;
    const last = index === segments.length - 1;
    crumbs.push({ id: last && isFile ? `file:${prefix}` : `dir:${prefix}`, label: segment });
  });
  return crumbs;
}
