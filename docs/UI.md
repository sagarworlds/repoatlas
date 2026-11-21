# UI

React + Vite + TypeScript, TanStack Query for data, React Router for routes,
Cytoscape.js for graphs (`cytoscape-fcose` for the map, `cytoscape-dagre` for call
flow), Shiki for syntax highlighting. Styling: Tailwind CSS. Light and dark themes
(follow `prefers-color-scheme`, with a toggle). Use our own name and visual identity;
do not copy another product's branding or assets.

## Routes

| Route | View |
|---|---|
| `/` | Home: analyze form, example repos, recent analyses |
| `/a/:analysisId` | Explorer (default tab: Map) |
| `/a/:analysisId?tab=flow&node=...` | Call flow focused on a node |
| `/a/:analysisId?tab=deps&file=...` | Dependencies of a file |

All explorer state that matters (tab, selected node, root, filters) lives in the URL
query string so links are shareable and back/forward works.
Parameters (defaults omitted): `tab`, `node`, `file`, `root`, `level`, `kinds`, `conf`, `tests`,
`ext`, `depth`, `up`, `down`, `dir`, `hl` (`path@line`, a call-site highlight). Changing `node`
clears `file` and `hl` unless the same change sets them (DECISIONS D26).

Implementation notes (M2): call-flow depth controls offer 0-4; the confidence filter is applied
client-side because `/callflow` has no confidence parameter; Expand/Focus buttons live in a status
bar under the map toolbar in addition to double-click; fresh map layouts are not animated; above
800 nodes the layout is a cheaper draft (a pause is still possible near the 2,000-node cap); the
code panel loads at most 2,000 lines per request.

## Home

- Input: GitHub URL (accept `owner/repo` shorthand too) + optional ref. Inline
  validation; show supported languages as small chips.
- "Try" examples: 3–4 small, well-known repos in different languages (one TS, one
  Python, one Go...). Keep the list in a config file.
- Recent: user's own recent analyses from `localStorage` (id, repo, date, status),
  then global recent from `GET /api/analyses`.
- After submit: navigate to `/a/:id`, which shows a progress view until `done`.

## Progress view

Poll `GET /api/analyses/:id` every 1s (TanStack Query `refetchInterval`) until
`done`/`failed`. Show phase steps (fetching → parsing → resolving → persisting) and a
`filesDone / filesTotal` bar. On failure, show the error message and a retry button.

## Explorer layout

```
┌──────────────────────────────────────────────────────────────────┐
│ repo name @ sha   [Map] [Call flow] [Dependencies]   🔍 search   │
├──────────────┬───────────────────────────────────┬───────────────┤
│ File tree    │        Graph canvas               │ Detail panel  │
│ (collapsible)│                                   │ (selected     │
│              │                                   │  node)        │
├──────────────┴───────────────────────────────────┴───────────────┤
│ Code panel (resizable, collapsible): source of selected node     │
└──────────────────────────────────────────────────────────────────┘
```
Responsive: below 900px, tree and detail panel become drawers; code panel becomes a
full-screen sheet.

### File tree
From `GET /graph?level=file&depth=5` (or lazily per directory). Clicking a node
selects it everywhere (tree, canvas, detail panel). Language icon per file.

### Map tab
- Start at `level=dir`, `root=dir:`, `depth=2`. Directories are Cytoscape **compound
  nodes** containing children; double-click a directory to expand it (fetch its
  subgraph and merge), or "focus" to make it the new root (breadcrumb shows path).
- Node size ∝ `log(degree)`; color by top-level directory (stable palette by hash).
  Symbol nodes shaped by kind (class = round-rect, function = ellipse, method =
  small ellipse, interface = diamond, external = dashed border).
- Edge width ∝ `log(weight)`. `name-match` edges dashed, `inferred` solid, `exact`
  solid + slightly darker. Arrowheads on.
- Toolbar: level (dir/file/symbol), edge kinds, min confidence, include tests,
  include external, "highlight most connected" (top 10 by degree), fit, export PNG.
- Hover: highlight node + neighbours, fade others. Click: select.
- Performance: never render > 2,000 nodes; use `cy.batch()` for merges; disable edge
  labels when > 500 edges.

### Call flow tab
- Requires a function/method selection (prompt to pick one via search otherwise).
- `GET /callflow` → dagre layout, left-to-right: callers ← **focus** → callees.
- Each node shows name + signature (truncated); each edge shows call-site line on hover.
- Controls: depth up/down (1–4), min confidence. Click a node → re-focus on it
  (push to URL history so Back returns).
- Clicking an edge opens the code panel at the **call-site line** in the caller.

### Dependencies tab
- Requires a file. Three columns: **imported by** (left) → **file** (center) →
  **imports** (right), with externals grouped at the bottom of the right column.
- Depth control 1–3; clicking a file makes it the center.

### Detail panel
Kind, name, qualified name, signature, file:lines, language, confidence legend,
counts (callers/callees/imports/importedBy) as links that switch tabs, list of
children (methods of a class, symbols of a file).

### Code panel
`GET /source` for the file or node span (± 5 lines context). Shiki highlighting with
line numbers starting at the real start line; highlight the selected span or call-site
line. Actions: copy, open on GitHub (`https://github.com/{owner}/{repo}/blob/{sha}/{path}#L{a}-L{b}`),
full screen. Load Shiki languages lazily.

### Search
Debounced (200 ms) `GET /search`; keyboard: `/` or `Ctrl/Cmd+K` to open, arrows to
move, Enter to select (selects node and opens the most relevant tab).

## Empty, loading and error states
Every panel has explicit states. A file with parse errors shows a small warning badge.
Show a banner in the explorer when stats show a low resolution rate (< 50%) for a
language: "Call links for <language> are approximate (dashed lines are name matches)."

## Accessibility
Keyboard-navigable tree and search; visible focus; color is never the only signal
(edge confidence also uses dash style; node kinds also use shape).
