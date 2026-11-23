# Go tree-sitter queries

`definitions.scm`, `imports.scm` and `references.scm` are loaded by `src/spec/queries.ts`
and run by the generic engine in `packages/treesitter`. Capture conventions are described
in `packages/treesitter/README.md`.

## Attribution

The definition and call patterns are adapted from `queries/tags.scm` of
[tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go), which is distributed
under the MIT licence (Copyright (c) 2014 Max Brunsfeld). The import, composite-literal,
`new(T)`, generic-call and embedding patterns were written for RepoAtlas.

## What the queries do not do

Methods, struct/interface/alias kinds, receivers, type references, `self` receivers and
file metadata are computed in `src/extract/post-process.ts` from the syntax tree.

## Deployment

The `.scm` files are read from disk at run time. A bundled server must copy this folder
next to the bundle and set `GO_QUERIES_DIR` to it (see `src/spec/queries.ts`).
