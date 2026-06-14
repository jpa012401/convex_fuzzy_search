# Phase 4 · S2 — Indexed Filtering — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Scope:** Resolve `filter_by` to a document-id set through a write-maintained index, so filtered queries no longer load the whole collection. Unified: filtering goes through the index on **all** paths (browse+filter and text+filter).
**Part of:** Phase 4 indexed-retrieval program (S2 of S1→S5). Depends on S1 (counters + lean reads).

## Problem

After S1, text search loads only matched docs and `out_of` is a counter — but **filtering is still in-memory over the loaded set**, and **browse+filter still loads the entire collection** (the documented S1 fallback). S2 makes `filter_by` resolve to a docId set via indexes, eliminating the full load for filtered queries and (per the decided "unify" approach) routing text+filter through the same resolver.

## Decision: unify on the index resolver

Filtering always resolves to a `Set<docId>` from indexes, then intersects with the path's candidate set:
- **Browse + filter:** the filter docId set *is* the result set (no full collection load).
- **Text + filter:** intersect the postings match set with the filter docId set.
Both then load only the surviving docs for facet/sort/hydrate. The in-memory predicate is retained only for unit-level reuse/back-compat, not used by `search`.

(Tradeoff accepted: resolving a filter reads its matching index rows even when the text match is already small; chosen for a single uniform path that also scales when text matches are large.)

## Data model

New table, maintained in the write path for **declared `filterFields`** only:
```
filters
  collection: string
  field: string
  docId: string
  strVal?: string   // set when the field's declared type is "string"
  numVal?: number   // set when the field's declared type is "number"
  index by_str [collection, field, strVal]   // exact + in-set
  index by_num [collection, field, numVal]    // comparators + range
  index by_doc [collection, docId]            // delete on upsert/delete
```
- One row per declared filter field that the document actually has a coercible value for. A `string` field stores `strVal = String(value)`; a `number` field stores `numVal = Number(value)` only if not `NaN` (missing/non-coercible → no row → the clause is false for that doc, matching the current predicate semantics).
- Write path: on upsert, after clearing the doc's old filter rows (via `by_doc`), insert new ones; on delete, clear them. Same lifecycle as postings.

## Filter resolver (refactor `filter.ts`)

Today `parseFilter(input, fieldTypes)` returns a closure predicate. Refactor into:
- `parseFilterAst(input, fieldTypes): FilterAst` — tokenizer + recursive-descent producing an explicit node tree (`and`/`or`/`exact`/`inSet`/`cmp`/`range`, each leaf carrying field, type, and value(s)). All current parse-time validation (unknown field, comparator/range on string field, malformed, non-numeric literal) is unchanged.
- `astToPredicate(ast): (stored)=>boolean` — the existing in-memory semantics (kept for reuse/tests). `parseFilter` becomes `astToPredicate(parseFilterAst(...))` so existing callers/tests are unaffected.
- `resolveAstToDocIds(ctx, collection, ast): Promise<Set<string>>` — walks the AST against the indexes:
  - `exact field:v` (string) → `by_str` eq `[collection, field, v]` → docIds.
  - `inSet field:[a,b]` → union of exacts.
  - `cmp field >n / >=n / <n / <=n` (number) → `by_num` range scan (`gt/gte/lt/lte` on `numVal`) → docIds.
  - `range field:[lo..hi]` → `by_num` `gte lo ∧ lte hi`.
  - `and` → intersect child sets (resolve smaller first); `or` → union.
  Returns the matching docId set without loading any `documents` rows.

## Search integration (`search.ts`)

When `filterBy` is present and non-empty, resolve once: `filterIds = resolveAstToDocIds(ctx, collection, parseFilterAst(filterBy, fieldTypes))`.

- **Text path:** compute the postings match set as today; `matchedIds = matchedIds.filter(id => filterIds.has(id))` (intersection). Load only those.
- **Browse + filter:** `matchedIds = [...filterIds]`. Load only those. (No full-collection scan.)
- **Browse, no filter:** unchanged S1 lean browse (aggregate paging).
- `found`, faceting, ranking/sort, pagination, hydration all run over the resulting bounded set exactly as now — only the *source* of the filtered id set changes.

Facets and sort still operate in-memory over the (now index-derived) matched set — exact, bounded by the filter result. (Scalable facet **counts** are S3; fixed-field sort indexes are S4.)

## Error handling

- Parse errors (unknown field, comparator on string, malformed, non-numeric literal) thrown at `parseFilterAst` time — identical messages to today.
- A filter field with no `filters` rows (e.g. value never indexed) resolves to an empty set → `found 0`, consistent.
- Resolver only reads indexes it has; an `or` with one broad branch can be large (inherent, bounded by matching rows).

## Migration / backfill

The `filters` table is empty for documents indexed before S2. Provide an idempotent **filter-row backfill** (paginated mutation over `documents`, re-deriving filter rows from `stored` using the collection's `filterFields`), mirroring S1's counter backfill (manual cursor paging — `ctx.db.query().paginate()` is app-only and throws inside a component). Or re-upsert. Until backfilled, filtered queries under-return for old docs — document clearly.

## Known limits after S2

- Negation (`!=`) still deferred.
- Array-valued filter/facet fields still deferred.
- Facet **counts** still tallied in-memory over the matched set (S3 adds counters).
- Sorting still in-memory over the matched set (S4 adds sort indexes).
- A broad filter branch resolves to a large id set (inherent).

## Testing strategy (TDD)

- **`parseFilterAst` / `astToPredicate`:** existing `filter.test.ts` behavior preserved (all current cases pass via the back-compat `parseFilter`). Add AST-shape assertions if helpful.
- **Write-path filter rows:** upsert writes rows for declared filter fields (string→strVal, number→numVal); missing/non-coercible → no row; re-upsert replaces (no orphans); delete clears; deleteCollection clears; multi-collection isolation.
- **`resolveAstToDocIds`:** exact, in-set, each comparator, range, `&&` intersect, `||` union, nested parens — each returns the correct docId set against a fixture (compare to the in-memory predicate over the same fixture for equivalence).
- **Search integration:** browse+filter returns correct `found`/hits **without** loading the whole collection (golden vs pre-S2 results); text+filter intersection correct; filter combined with facets/sort still correct.
- **Backfill:** rebuilds filter rows for pre-existing docs; idempotent.
- Full existing suite stays green (filtered/faceted results identical).
