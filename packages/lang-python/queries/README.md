# Python tree-sitter queries

`definitions.scm`, `imports.scm` and `references.scm` are loaded by `src/spec/queries.ts`
and run by the generic engine in `packages/treesitter`. Capture conventions are described
in `packages/treesitter/README.md`.

## Attribution

The definition and call patterns are adapted from `queries/tags.scm` of
[tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python), which is
distributed under the MIT licence (Copyright (c) 2016 Max Brunsfeld). The import,
decorator and base-class patterns were written for RepoAtlas.

## Deployment

The `.scm` files are read from disk at run time. A bundled server must copy this folder
next to the bundle and set `PYTHON_QUERIES_DIR` to it (see `src/spec/queries.ts`).
