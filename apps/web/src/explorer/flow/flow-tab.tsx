import { useCallflow } from "../../api/hooks.ts";
import type { AnalysisRecordDto, CallflowResponse, GraphEdge, GraphNode } from "../../api/types.ts";
import { useExplorerParams } from "../url-state.ts";
import { FlowCanvas } from "./flow-canvas.tsx";
import { FlowControls } from "./flow-controls.tsx";
import {
  edgeById,
  edgeToSelection,
  FLOW_NODE_LIMIT,
  isCallable,
  isFlowEmpty,
} from "./flow-model.ts";
import { FlowError, FlowMessage, NotCallablePrompt, PickFunctionPrompt } from "./flow-prompts.tsx";
import { FlowTextList } from "./flow-text-list.tsx";

/** Call flow tab: callers <- focus -> callees of the function in the `node` URL parameter. */
export function FlowTab(props: { analysisId: string; analysis: AnalysisRecordDto }) {
  const { params, setParams } = useExplorerParams();
  const nodeId = params.node;
  const flow = useCallflow(props.analysisId, nodeId, params.up, params.down, params.conf);

  // Re-focusing pushes a history entry, so the browser's Back button returns to the old focus.
  const focusOn = (node: GraphNode) => setParams({ node: node.id, hl: undefined }, { push: true });

  if (nodeId === undefined) return <PickFunctionPrompt />;
  if (flow.isError) {
    return <FlowError error={flow.error} onRetry={() => void flow.refetch()} />;
  }
  // While another node's data is still shown as placeholder, `focus` differs from the URL.
  if (flow.isPending || flow.data.focus !== nodeId) {
    return (
      <FlowMessage title="Loading call flow…" role="status" testId="flow-loading">
        <p>Fetching callers and callees.</p>
      </FlowMessage>
    );
  }

  const data = flow.data;
  const focus = data.nodes.find((n) => n.id === data.focus);
  if (!focus || !isCallable(focus)) {
    return (
      <NotCallablePrompt
        analysisId={props.analysisId}
        nodeId={nodeId}
        node={focus}
        onPick={focusOn}
      />
    );
  }

  const nodesById = new Map(data.nodes.map((n) => [n.id, n]));

  const openCall = (edge: GraphEdge) => {
    const selection = edgeToSelection(edge, nodesById);
    if (selection) setParams({ node: selection.callerId, hl: selection.hl }, { push: true });
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="flow-tab"
      aria-busy={flow.isFetching}
    >
      <FlowControls up={params.up} down={params.down} conf={params.conf} onChange={setParams} />
      {data.nodes.length >= FLOW_NODE_LIMIT && (
        <p
          role="status"
          className="bg-warn-soft px-3 py-2 text-sm text-warn"
          data-testid="flow-truncated"
        >
          The result was limited to {FLOW_NODE_LIMIT} functions, so some callers or callees are
          missing. Lower the depth or raise the minimum confidence.
        </p>
      )}
      {isFlowEmpty(data) ? (
        <EmptyFlow focus={focus} up={params.up} down={params.down} />
      ) : (
        <>
          <FlowCanvas
            data={data}
            onNodeClick={(id) => {
              const node = nodesById.get(id);
              if (node && id !== data.focus && isCallable(node)) focusOn(node);
            }}
            onEdgeClick={(edgeId) => {
              const edge = edgeById(data, edgeId);
              if (edge) openCall(edge);
            }}
          />
          <TextAlternative data={data} onFocusNode={focusOn} onOpenCall={openCall} />
        </>
      )}
    </div>
  );
}

function EmptyFlow(props: { focus: GraphNode; up: number; down: number }) {
  return (
    <FlowMessage title="No callers or callees found" testId="flow-empty">
      <p>
        <span className="font-mono">{props.focus.name}</span> has no call links within {props.up}{" "}
        level(s) up and {props.down} level(s) down at this confidence.
      </p>
      <p>
        Try a larger depth or a lower minimum confidence. Calls through dynamic dispatch or
        callbacks may not be detected.
      </p>
    </FlowMessage>
  );
}

function TextAlternative(props: {
  data: CallflowResponse;
  onFocusNode: (node: GraphNode) => void;
  onOpenCall: (edge: GraphEdge) => void;
}) {
  return (
    <details className="max-h-64 shrink-0 overflow-auto border-t border-line bg-surface">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
        List view of callers and callees
      </summary>
      <FlowTextList {...props} />
    </details>
  );
}
