import { useMemo } from "react";
import type { CallflowResponse, GraphEdge, GraphNode } from "../../api/types.ts";
import { buildCallTree, type CallTreeItem, describeFlowNode } from "./flow-model.ts";

interface FlowTextListProps {
  data: CallflowResponse;
  onFocusNode: (node: GraphNode) => void;
  onOpenCall: (edge: GraphEdge) => void;
}

/** Text alternative to the canvas: the same callers and callees as nested lists. */
export function FlowTextList({ data, onFocusNode, onOpenCall }: FlowTextListProps) {
  const callers = useMemo(() => buildCallTree(data, "callers"), [data]);
  const callees = useMemo(() => buildCallTree(data, "callees"), [data]);
  const focus = data.nodes.find((n) => n.id === data.focus);

  return (
    <div className="grid gap-4 p-3 text-sm md:grid-cols-2">
      <section aria-labelledby="flow-callers-heading">
        <h3 id="flow-callers-heading" className="mb-1 font-semibold">
          Callers of {focus?.name ?? "the function"} ({callers.length} direct)
        </h3>
        <TreeList items={callers} direction="callers" {...{ onFocusNode, onOpenCall }} />
      </section>
      <section aria-labelledby="flow-callees-heading">
        <h3 id="flow-callees-heading" className="mb-1 font-semibold">
          Callees of {focus?.name ?? "the function"} ({callees.length} direct)
        </h3>
        <TreeList items={callees} direction="callees" {...{ onFocusNode, onOpenCall }} />
      </section>
    </div>
  );
}

function TreeList(props: {
  items: CallTreeItem[];
  direction: "callers" | "callees";
  onFocusNode: (node: GraphNode) => void;
  onOpenCall: (edge: GraphEdge) => void;
}) {
  if (props.items.length === 0) {
    return <p className="text-muted">None at this depth.</p>;
  }
  return (
    <ul className="space-y-1">
      {props.items.map((item) => (
        <li key={`${item.edge.src}>${item.edge.dst}`}>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <button
              type="button"
              title={describeFlowNode(item.node)}
              onClick={() => props.onFocusNode(item.node)}
              className="rounded px-1 text-left font-mono text-xs underline decoration-dotted hover:bg-surface-2"
            >
              {item.node.name}
            </button>
            <button
              type="button"
              onClick={() => props.onOpenCall(item.edge)}
              disabled={item.edge.line === undefined}
              aria-label={`Open call site${item.edge.line !== undefined ? ` at line ${item.edge.line}` : ""} (${item.edge.confidence})`}
              className="rounded px-1 text-xs text-muted hover:bg-surface-2 disabled:no-underline"
            >
              {item.edge.line !== undefined ? `line ${item.edge.line}` : "line ?"} &middot;{" "}
              {item.edge.confidence}
            </button>
            {item.repeated && <span className="text-xs text-muted">(listed above)</span>}
          </div>
          {item.children.length > 0 && (
            <div className="ml-4 border-l border-line pl-2">
              <TreeList {...props} items={item.children} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
