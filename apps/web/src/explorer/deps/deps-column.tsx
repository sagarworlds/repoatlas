import clsx from "clsx";
import type { ReactNode } from "react";
import type { Confidence } from "../../api/types.ts";
import { type DepItem, edgeMetaText } from "./deps-model.ts";

/** Splits "src/a/b.ts" into the folder part ("src/a/") and the file name ("b.ts"). */
export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/** Confidence as text plus line style: name-match gets a dashed outline, never colour alone. */
export function ConfidenceTag({ confidence }: { confidence: Confidence }) {
  return (
    <span
      className={clsx(
        "rounded border px-1 text-[11px] leading-4 text-muted",
        confidence === "name-match" ? "border-dashed border-muted" : "border-solid border-line",
        confidence === "exact" && "font-semibold",
      )}
      title={`Resolution confidence: ${confidence}`}
    >
      {confidence}
    </span>
  );
}

interface DepsColumnProps {
  title: string;
  /** Names the relationship for screen readers, e.g. "Files that import this file". */
  description: string;
  items: DepItem[];
  emptyText: string;
  side: "left" | "right";
  /** Rendered after the list (the externals group lives at the bottom of the right column). */
  footer?: ReactNode;
  onSelect: (item: DepItem) => void;
}

export function DepsColumn(props: DepsColumnProps) {
  const left = props.side === "left";
  return (
    <section
      aria-label={props.description}
      className={clsx(
        "min-w-0 space-y-3 border-line p-3",
        left ? "md:border-r-2 md:pr-5" : "md:border-l-2 md:pl-5",
      )}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{props.title}</h3>
      {props.items.length === 0 ? (
        <p className="text-sm text-muted">{props.emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {props.items.map((item) => (
            <DepsItemView
              key={item.node.id}
              item={item}
              side={props.side}
              top
              onSelect={props.onSelect}
            />
          ))}
        </ul>
      )}
      {props.footer}
    </section>
  );
}

function DepsItemView(props: {
  item: DepItem;
  side: "left" | "right";
  top?: boolean;
  onSelect: (item: DepItem) => void;
}) {
  const { item } = props;
  const { dir, base } = splitPath(item.path);
  const left = props.side === "left";
  const meta = edgeMetaText(item.edge);
  return (
    <li className="relative">
      {props.top && (
        // The connector stub towards the centre file (desktop only; decoration).
        <span
          aria-hidden="true"
          className={clsx(
            "absolute top-5 hidden w-4 border-t-2 md:block",
            item.edge.confidence === "name-match" ? "border-dashed" : "border-solid",
            "border-muted",
            left ? "-right-5" : "-left-5",
          )}
        />
      )}
      <div className="rounded-md border border-line bg-surface">
        <button
          type="button"
          onClick={() => props.onSelect(item)}
          aria-label={`Show dependencies of ${item.path}`}
          title={item.path}
          className="block w-full truncate rounded-t-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
        >
          <span className="text-muted">{dir}</span>
          <span className="font-semibold">{base}</span>
        </button>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-1.5 text-xs text-muted">
          {item.hop > 1 && <span className="font-medium">hop {item.hop}</span>}
          <ConfidenceTag confidence={item.edge.confidence} />
          {item.circular && (
            <span title="This file is also on the other side: the files import each other (directly or not).">
              &#8644; circular
            </span>
          )}
          {meta.length > 0 && <span className="break-words">{meta.join(" · ")}</span>}
        </div>
      </div>
      {item.children.length > 0 && (
        <ul
          aria-label={`${left ? "Importers" : "Imports"} reached through ${base}`}
          className="ml-4 mt-2 space-y-2 border-l-2 border-dashed border-line pl-3"
        >
          {item.children.map((child) => (
            <DepsItemView
              key={child.node.id}
              item={child}
              side={props.side}
              onSelect={props.onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
