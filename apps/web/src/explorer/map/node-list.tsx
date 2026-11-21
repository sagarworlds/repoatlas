import { useMemo, useState } from "react";
import type { GraphLevel } from "../../api/types.ts";
import { isExpandable, type MapNode } from "./graph-model.ts";

/** Rows rendered at once; the filter box narrows the rest. */
export const NODE_LIST_LIMIT = 200;

export interface NodeListProps {
  nodes: readonly MapNode[];
  level: GraphLevel;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onExpand: (id: string) => void;
  onFocus: (id: string) => void;
}

/** Filtered, most-connected-first nodes (pure, exported for tests). */
export function filterNodes(nodes: readonly MapNode[], filter: string): MapNode[] {
  const needle = filter.trim().toLowerCase();
  return nodes
    .filter(
      (n) =>
        needle === "" ||
        n.label.toLowerCase().includes(needle) ||
        n.path.toLowerCase().includes(needle),
    )
    .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1));
}

/** Keyboard-friendly alternative to the canvas: every node is a real button in a real table. */
export function NodeList(props: NodeListProps) {
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => filterNodes(props.nodes, filter), [props.nodes, filter]);
  const shown = rows.slice(0, NODE_LIST_LIMIT);

  return (
    <section
      id="map-node-list"
      aria-label="List of nodes"
      className="max-h-64 overflow-auto border-t border-line bg-surface text-xs"
    >
      <div className="sticky top-0 flex items-center gap-3 border-b border-line bg-surface px-3 py-2">
        <label className="flex items-center gap-2">
          <span className="text-muted">Filter</span>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 w-48 rounded-md border border-line-strong bg-bg px-2 text-fg"
          />
        </label>
        <span className="text-muted" aria-live="polite">
          {rows.length > NODE_LIST_LIMIT
            ? `Showing ${NODE_LIST_LIMIT} of ${rows.length}`
            : `${rows.length} nodes`}
        </span>
      </div>
      <table className="w-full text-left">
        <caption className="sr-only">Nodes in the map, most connected first</caption>
        <thead className="text-muted">
          <tr>
            <th scope="col" className="px-3 py-1 font-medium">
              Name
            </th>
            <th scope="col" className="px-3 py-1 font-medium">
              Kind
            </th>
            <th scope="col" className="px-3 py-1 font-medium">
              Connections
            </th>
            <th scope="col" className="px-3 py-1 font-medium">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((n) => (
            <tr
              key={n.id}
              aria-selected={n.id === props.selectedId}
              className={n.id === props.selectedId ? "bg-accent-soft" : undefined}
            >
              <td className="px-3 py-1">
                <button
                  type="button"
                  onClick={() => props.onSelect(n.id)}
                  aria-pressed={n.id === props.selectedId}
                  title={n.path || undefined}
                  className="max-w-xs truncate text-left font-medium text-accent-strong hover:underline"
                >
                  {n.label}
                </button>
              </td>
              <td className="px-3 py-1">{n.kind}</td>
              <td className="px-3 py-1">{n.degree}</td>
              <td className="space-x-2 px-3 py-1">
                {isExpandable(n, props.level) && (
                  <>
                    <button
                      type="button"
                      onClick={() => props.onExpand(n.id)}
                      className="underline-offset-2 hover:underline"
                      aria-label={`Expand ${n.label}`}
                    >
                      Expand
                    </button>
                    <button
                      type="button"
                      onClick={() => props.onFocus(n.id)}
                      className="underline-offset-2 hover:underline"
                      aria-label={`Focus on ${n.label}`}
                    >
                      Focus
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
