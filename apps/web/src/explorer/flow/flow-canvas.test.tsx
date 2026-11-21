import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CallflowResponse } from "../../api/types.ts";

// The adapter would load Cytoscape (needs a canvas), so replace it with a fake.
vi.mock("./cy-flow-adapter.ts", () => ({
  mountFlowGraph: vi.fn(() =>
    Promise.resolve({ setElements() {}, setPalette() {}, fit() {}, destroy() {} }),
  ),
}));

import { FlowCanvas } from "./flow-canvas.tsx";

describe("FlowCanvas", () => {
  it("positions the Cytoscape container with an inline style so injected CSS cannot collapse it", () => {
    const data = { focus: "a", nodes: [], edges: [] } as unknown as CallflowResponse;
    render(<FlowCanvas data={data} onNodeClick={() => {}} onEdgeClick={() => {}} />);
    const el = screen.getByTestId("flow-canvas");
    expect(el.style.position).toBe("absolute");
    expect(el.style.inset).toBe("0px");
  });
});
