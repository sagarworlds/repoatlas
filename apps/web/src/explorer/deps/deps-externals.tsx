import { ConfidenceTag } from "./deps-column.tsx";
import { type ExternalGroup, edgeMetaText } from "./deps-model.ts";

/** External packages (and unresolved modules) grouped by ecosystem. Text only: not clickable. */
export function DepsExternals({ groups }: { groups: ExternalGroup[] }) {
  if (groups.length === 0) return null;
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  return (
    <section
      aria-label="External packages"
      data-testid="deps-externals"
      className="mt-4 space-y-2 border-t-2 border-line pt-3"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
        External packages ({total})
      </h3>
      {groups.map((group) => (
        <div key={group.label}>
          <h4 className="mb-1 text-xs font-medium text-muted">{group.label}</h4>
          <ul className="space-y-1">
            {group.items.map((item) => {
              const meta = edgeMetaText(item.edge);
              return (
                <li
                  key={item.node.id}
                  className="rounded-md border border-dashed border-muted bg-surface px-2 py-1 text-sm"
                >
                  <span className="font-mono font-semibold">{item.name}</span>
                  <span className="ml-2 inline-flex flex-wrap items-center gap-x-2 text-xs text-muted">
                    <ConfidenceTag confidence={item.edge.confidence} />
                    <span title={item.usedBy.join("\n")}>
                      used by {item.usedBy.length} file{item.usedBy.length === 1 ? "" : "s"}
                    </span>
                    {meta.length > 0 && <span className="break-words">{meta.join(" · ")}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
