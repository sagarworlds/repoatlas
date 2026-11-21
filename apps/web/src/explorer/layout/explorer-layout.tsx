import clsx from "clsx";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AnalysisRecordDto } from "../../api/types.ts";
import { Drawer } from "../../components/drawer.tsx";
import { useDocumentTitle } from "../../lib/use-document-title.ts";
import { useIsNarrow } from "../../lib/use-media-query.ts";
import { useExplorerParams } from "../url-state.ts";
import { ExplorerHeader } from "./explorer-header.tsx";
import {
  CODE_HEIGHT_MIN,
  COLLAPSED_STRIP_HEIGHT,
  clampSize,
  type LayoutPrefs,
  readLayoutPrefs,
  writeLayoutPrefs,
} from "./layout-prefs.ts";
import { ResizeHandle } from "./resize-handle.tsx";

const TREE_WIDTH = 280;
const DETAIL_WIDTH = 320;

export interface ExplorerLayoutProps {
  analysis: AnalysisRecordDto;
  /** Search box shown in the header bar. */
  search: ReactNode;
  /** Optional banner between header and panels (e.g. low resolution warning). */
  banner?: ReactNode;
  tree: ReactNode;
  /** The active tab component (the page chooses it from the `tab` URL parameter). */
  canvas: ReactNode;
  detail: ReactNode;
  /** Receives `onClose`, which collapses the code panel (desktop) or closes the sheet (narrow). */
  code: (api: { onClose: () => void }) => ReactNode;
}

/**
 * The explorer frame from docs/UI.md. Wide screens: header, file tree | canvas | detail panel
 * and a resizable, collapsible code panel. Below 900px the tree and detail panel become
 * drawers and the code panel a full-screen sheet. It only arranges slots, owns no data.
 */
export function ExplorerLayout(props: ExplorerLayoutProps) {
  const { analysis } = props;
  const { params } = useExplorerParams();
  const narrow = useIsNarrow();
  useDocumentTitle(`${analysis.owner}/${analysis.repo}`);

  // Lazy initializer: reads localStorage once.
  const [prefs, setPrefs] = useState<LayoutPrefs>(() => readLayoutPrefs());
  const [maxHeight, setMaxHeight] = useState(() => window.innerHeight * 0.7);
  const [treeDrawer, setTreeDrawer] = useState(false);
  const [detailDrawer, setDetailDrawer] = useState(false);
  const [codeSheet, setCodeSheet] = useState(false);
  const canvasRef = useRef<HTMLElement>(null);

  // Effect = "run after render when these values changed" (a side-effect subscription).
  useEffect(() => {
    writeLayoutPrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    const onResize = () => setMaxHeight(window.innerHeight * 0.7);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // A new call-site highlight should be visible, so reveal the code panel / sheet.
  useEffect(() => {
    if (params.hl === undefined) return;
    setPrefs((p) => (p.codeOpen ? p : { ...p, codeOpen: true }));
    setCodeSheet(true);
  }, [params.hl]);

  // Picking something in a drawer should reveal the result, so drawers close on selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection is the trigger
  useEffect(() => {
    setTreeDrawer(false);
    setDetailDrawer(false);
  }, [params.node, params.file, params.tab]);

  // Leaving the narrow layout must not leave a stale modal state behind.
  useEffect(() => {
    if (!narrow) {
      setTreeDrawer(false);
      setDetailDrawer(false);
      setCodeSheet(false);
    }
  }, [narrow]);

  const hasSelection = params.node !== undefined || params.file !== undefined;
  const closeSheet = () => setCodeSheet(false);

  const header = (
    <ExplorerHeader
      analysis={analysis}
      search={props.search}
      narrow={narrow}
      treeOpen={prefs.treeOpen}
      onToggleTree={() =>
        narrow ? setTreeDrawer(true) : setPrefs((p) => ({ ...p, treeOpen: !p.treeOpen }))
      }
      onOpenDetail={() => setDetailDrawer(true)}
      onOpenCode={hasSelection ? () => setCodeSheet(true) : undefined}
    />
  );

  const skipLink = (
    <button
      type="button"
      onClick={() => canvasRef.current?.focus()}
      className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg"
    >
      Skip to canvas
    </button>
  );

  const canvas = (
    <section
      ref={canvasRef}
      id="explorer-canvas"
      role="tabpanel"
      aria-labelledby={`tab-${params.tab}`}
      tabIndex={-1}
      className="relative min-h-0 min-w-0 overflow-auto bg-bg outline-none"
    >
      {props.canvas}
    </section>
  );

  if (narrow) {
    return (
      <div className="relative flex h-full min-h-0 flex-col" data-testid="explorer-layout">
        {skipLink}
        {header}
        {props.banner}
        <div className="flex min-h-0 flex-1 flex-col [&>section]:flex-1">{canvas}</div>
        <Drawer
          open={treeDrawer}
          onClose={() => setTreeDrawer(false)}
          label="File tree"
          side="left"
        >
          {props.tree}
        </Drawer>
        <Drawer
          open={detailDrawer}
          onClose={() => setDetailDrawer(false)}
          label="Details"
          side="right"
        >
          {props.detail}
        </Drawer>
        <Drawer open={codeSheet} onClose={closeSheet} label="Code" side="full">
          {props.code({ onClose: closeSheet })}
        </Drawer>
      </div>
    );
  }

  const codeHeight = clampSize(prefs.codeHeight, CODE_HEIGHT_MIN, maxHeight);
  const gridStyle = {
    gridTemplateColumns: `${prefs.treeOpen ? TREE_WIDTH : 0}px minmax(0, 1fr) ${DETAIL_WIDTH}px`,
    gridTemplateRows: `minmax(0, 1fr) ${prefs.codeOpen ? "auto" : "0"} ${
      prefs.codeOpen ? codeHeight : COLLAPSED_STRIP_HEIGHT
    }px`,
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="explorer-layout">
      {skipLink}
      {header}
      {props.banner}

      <div className="grid min-h-0 flex-1" style={gridStyle}>
        <aside
          aria-label="File tree"
          // `invisible` (visibility: hidden) also removes the hidden tree from the tab order.
          className={clsx(
            "col-start-1 row-start-1 min-h-0 overflow-auto border-r border-line bg-surface",
            !prefs.treeOpen && "invisible",
          )}
        >
          {props.tree}
        </aside>

        <div className="col-start-2 row-start-1 flex min-h-0 min-w-0 flex-col [&>section]:flex-1">
          {canvas}
        </div>

        <aside
          aria-label="Details"
          className="col-start-3 row-start-1 min-h-0 overflow-auto border-l border-line bg-surface"
        >
          {props.detail}
        </aside>

        {prefs.codeOpen && (
          <ResizeHandle
            label="Resize code panel"
            value={codeHeight}
            min={CODE_HEIGHT_MIN}
            max={maxHeight}
            onChange={(codeHeight) => setPrefs((p) => ({ ...p, codeHeight }))}
          />
        )}

        <section
          aria-label="Code"
          className={clsx(
            "col-span-3 col-start-1 row-start-3 min-h-0 overflow-auto border-t border-line bg-surface",
            !prefs.codeOpen && "overflow-hidden",
          )}
        >
          {prefs.codeOpen ? (
            props.code({ onClose: () => setPrefs((p) => ({ ...p, codeOpen: false })) })
          ) : (
            <button
              type="button"
              onClick={() => setPrefs((p) => ({ ...p, codeOpen: true }))}
              aria-expanded={false}
              className="flex h-full w-full items-center gap-2 px-3 text-sm text-muted hover:bg-surface-2"
            >
              <span aria-hidden="true">{"▲"}</span> Show code panel
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
