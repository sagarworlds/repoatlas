# Java tree-sitter queries

`definitions.scm`, `imports.scm` and `references.scm` are loaded by `src/spec/queries.ts`
and run by the generic engine in `packages/treesitter`. Capture conventions are described
in `packages/treesitter/README.md`.

## Attribution

The definition and call patterns are adapted from `queries/tags.scm` of
[tree-sitter-java](https://github.com/tree-sitter/tree-sitter-java), which is distributed
under the MIT licence (Copyright (c) 2017 Ayman Nadeem). The import, heritage,
instantiation, method-reference and nesting-aware definition patterns were written for
RepoAtlas.

## What is not in the queries

Annotations and type references (fields, parameters, return types, generics, casts,
throws, catch types, class literals) are added by `postProcess` because they depend on the
parent node and on the type parameters in scope. `postProcess` also drops local classes
(and their members), which `definitions.scm` cannot tell apart from member classes.

## Deployment

The `.scm` files are read from disk at run time. A bundled server must copy this folder
next to the bundle and set `JAVA_QUERIES_DIR` to it (see `src/spec/queries.ts`).
