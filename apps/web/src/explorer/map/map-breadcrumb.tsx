import { Fragment } from "react";
import { buildBreadcrumb } from "./breadcrumb.ts";

export interface MapBreadcrumbProps {
  rootId: string;
  repoLabel: string;
  onNavigate: (id: string) => void;
}

/** Path from the repository root to the current map root. Earlier crumbs go up. */
export function MapBreadcrumb({ rootId, repoLabel, onNavigate }: MapBreadcrumbProps) {
  const crumbs = buildBreadcrumb(rootId, repoLabel);
  return (
    <nav aria-label="Map root" className="min-w-0 text-xs">
      <ol className="flex flex-wrap items-center gap-1">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <Fragment key={crumb.id}>
              {index > 0 && (
                <li aria-hidden="true" className="text-muted">
                  /
                </li>
              )}
              <li className="min-w-0">
                {last ? (
                  <span aria-current="page" className="truncate font-semibold">
                    {crumb.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onNavigate(crumb.id)}
                    className="truncate rounded px-1 text-accent-strong underline-offset-2 hover:underline"
                  >
                    {crumb.label}
                  </button>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
