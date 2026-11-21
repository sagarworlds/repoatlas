import type { ReactNode } from "react";
import { useNodeDetail } from "../../api/hooks.ts";
import type { GraphNode } from "../../api/types.ts";
import { describeError } from "../../lib/error-text.ts";
import { isCallable } from "./flow-model.ts";

/** Centered message used for every non-graph state of the tab. */
export function FlowMessage(props: {
  title: string;
  children?: ReactNode;
  role?: "status" | "alert";
  testId?: string;
}) {
  return (
    <div
      role={props.role}
      data-testid={props.testId}
      className="mx-auto max-w-lg space-y-3 px-6 py-12 text-center"
    >
      <h2 className="text-lg font-semibold">{props.title}</h2>
      <div className="space-y-2 text-sm text-muted">{props.children}</div>
    </div>
  );
}

/** Nothing selected: ask the user to pick a function. */
export function PickFunctionPrompt() {
  return (
    <FlowMessage title="Pick a function to see its call flow" testId="flow-prompt">
      <p>
        Use the search box at the top (press{" "}
        <kbd className="rounded border border-line px-1">/</kbd> or{" "}
        <kbd className="rounded border border-line px-1">Ctrl</kbd>+
        <kbd className="rounded border border-line px-1">K</kbd>) and choose a function or method.
        You can also select one in the file tree or on the map.
      </p>
      <p>The graph shows who calls it on the left and what it calls on the right.</p>
    </FlowMessage>
  );
}

/**
 * The selected node is a file, class, directory...: explain, and offer its functions and
 * methods (when the node detail lists any) as shortcuts.
 */
export function NotCallablePrompt(props: {
  analysisId: string;
  nodeId: string;
  node: GraphNode | undefined;
  onPick: (node: GraphNode) => void;
}) {
  const detail = useNodeDetail(props.analysisId, props.nodeId);
  const callable = (detail.data?.children ?? []).filter(isCallable).slice(0, 12);
  const label = props.node ? `${props.node.kind} ${props.node.name}` : "This node";
  return (
    <FlowMessage title="Call flow needs a function or method" testId="flow-not-callable">
      <p>
        <span className="font-mono">{label}</span> is not callable. Choose a function or method with
        the search box.
      </p>
      {callable.length > 0 && (
        <div>
          <p className="mb-2">Functions and methods inside it:</p>
          <ul className="flex flex-wrap justify-center gap-2">
            {callable.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => props.onPick(child)}
                  className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs hover:bg-surface-2"
                >
                  {child.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </FlowMessage>
  );
}

/** Loading error of the call flow request. */
export function FlowError(props: { error: { code?: string } & Error; onRetry: () => void }) {
  const notReady = props.error.code === "ANALYSIS_NOT_READY";
  const text = describeError(props.error);
  return (
    <FlowMessage
      role="alert"
      testId="flow-error"
      title={notReady ? "The analysis is not ready yet" : text.title}
    >
      <p>
        {notReady
          ? "Call data is available once the analysis has finished. Try again in a moment."
          : text.message}
      </p>
      <button
        type="button"
        onClick={props.onRetry}
        className="h-9 rounded-md bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-strong"
      >
        Try again
      </button>
    </FlowMessage>
  );
}
