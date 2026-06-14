# Phase 4 · S1 — Aggregate Backbone + Lean Reads — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Scope:** Remove the per-query full-collection load for the common paths by (a) maintaining counts/order in `@convex-dev/aggregate` on write, and (b) loading only the documents a query actually needs.
**Part of:** the Phase 4 indexed-retrieval program (S1 of S1→S5). End-state and sequence in the conversation; later slices: S2 indexed filtering, S3 aggregate facet counters, S4 fixed-field sort indexes, S5 hot-term postings sharding.

## Problem

Today every `search` call loads **all** documents in the collection
([search.ts](../../../src/component/search.ts) `allDocs`/`byId`) to compute
`out_of`, hydrate hits, and run in-memory filter/rank/facet. At ~5k this is a
felt delay; past ~16k it exceeds Convex's per-query read limit. S1 removes that
full load for the two common paths — text search and simple browse — and makes
`out_of` a counter read.

## Key architectural truth (bounds what S1 can do)

Weighted `rankBy` is computed at query time with caller-chosen weights, so it has
**no fixed sort key to index** — a weighted/relevance search must still
materialize its candidate set to rank it. That set is bounded by the **match**
(from postings), not the whole collection. So S1's win for text search is
"load matched, not all"; true index-seek pagination applies only to browse and
(later, S4) fixed-field sorts.

## Decisions (locked)

- Adopt **`@convex-dev/aggregate`**, installed **inside** the FuzzySearch
  component (consumers still install only FuzzySearch; nested components are
  supported and transactional).
- Use a **`DirectAggregate`** keyed by `docId`, **namespaced by collection**,
  maintained in the existing synchronous write path.
- S1 keeps results **exact**. It does not introduce approximation (that arrives
  with facet counters / hot-term sharding in S3/S5).

## Assumptions to validate FIRST (plan task 1 = spike)

1. A component can `app.use(@convex-dev/aggregate)` in its own
   `src/component/convex.config.ts` and call it via `components.aggregate`.
2. `convex-test` can exercise the component with the nested aggregate registered
   (module glob / component registration). If not, identify the supported test
   path before building further.
If either fails, stop and reassess (fallback: a hand-rolled internal sharded
counter for `out_of` + index-paginated browse, losing aggregate's ordered
offset but keeping the lean-reads win).

## Architecture

Install aggregate in the component and wrap one `DirectAggregate`:

```
// conceptual
docAgg = new DirectAggregate<{ Namespace: string; Key: string; Id: string }>(components.aggregate)
// Namespace = collection name, Key = docId (lexicographic browse order), Id = docId
```

Maintained in [write.ts](../../../src/component/write.ts):
- On **insert** of a new `documents` row → `docAgg.insertIfDoesNotExist(ctx, { namespace: collection, key: docId, id: docId })`.
- On **delete** (and the delete half of a replace) → `docAgg.delete(ctx, { namespace: collection, key: docId, id: docId })`.
- Re-upsert of an existing id: key/order unchanged → no aggregate change needed
  (delete-then-insert of the same key is a no-op net; implement as "insert only
  when the documents row did not previously exist, delete only when it did").
- `deleteCollection` must also clear the namespace (paginate + delete, or
  aggregate's clear API) — and this finally gives a scalable path to drop a
  collection (see the deleteCollection read-limit finding from the 5k test).

## Search data-flow changes ([search.ts](../../../src/component/search.ts))

`out_of` (always): `await docAgg.count(ctx, { namespace: collection })` — no scan.

Then branch by query shape:

1. **Text query (tokens present):** gather matched `docId`s from postings (as
   today) → load **only those** documents via the `by_collection_doc` index
   (one indexed read per id), build `byId` over the match set only. Apply filter,
   rank (`rankBy`/`sortBy`), facet, and hydrate over that bounded set. `found`
   and facet counts stay exact (the matched set is the result set). Reads ≈ match
   size, not collection size.

2. **Simple browse (empty `q`, no `filterBy`, no `facetBy`, default or docId
   order):** page directly off the aggregate — for `page`/`perPage`, read the
   page's `docId`s by rank (`docAgg.at(ctx, offset, { namespace })` across the
   window, or `docAgg.paginate`), then load **only those page docs**. `out_of`
   from `count`. No full load.

3. **Fallback (everything else):** browse combined with `filterBy`, `facetBy`,
   or a non-default `sortBy`/`rankBy` keeps the **current full-collection load**
   for now. These are precisely what S2 (indexed filter), S3 (facet counters),
   and S4 (sort indexes) replace. The fallback is correct, just not yet lean;
   document it.

The envelope, ranking semantics, highlighting, exactness, and the public API are
unchanged. Only the read strategy changes.

## Backfill / migration

Introducing the aggregate means existing documents aren't in it yet. Provide a
**backfill**: a paginated mutation/action that walks the `documents` table and
`insertIfDoesNotExist`s each into `docAgg` (idempotent). Until backfilled,
`out_of`/browse counts are wrong — so document that enabling S1 on an existing
deployment requires running the backfill once (the example simply re-seeds,
which now also populates the aggregate via the write path). A guard: if a spike
shows aggregate count diverging from a sampled table count, surface it.

## Error handling

- Aggregate maintenance happens in the same transaction as the document write;
  a failure aborts the whole upsert/delete (consistent, no partial state).
- `count`/`at` on an empty namespace return 0 / nothing — browse yields an empty
  page, `out_of` 0.
- Per-id document loads that miss (race) are skipped from hits (as today).

## Known limits after S1 (explicit)

- Browse **with** filter/facets/custom sort still loads the full collection
  (S2/S3/S4).
- Query-scoped facet counts are still computed over the loaded set (exact for
  text queries; full-load for browse-with-facets). Scalable facet counters = S3.
- Very common terms still read large postings/match sets (hot-term ceiling) — S5.
- Weighted `rankBy` pagination remains candidate-set-based by nature (not an
  index seek) — fundamental, documented above.

## Testing strategy (TDD)

- **Spike test (task 1):** a minimal component-internal aggregate insert+count
  under `convex-test`; confirms feasibility before more is built.
- **Write-path maintenance:** upsert of a new id increments the namespace count;
  re-upsert of the same id does not change it; delete decrements; multi-collection
  namespaces isolated; `deleteCollection` empties the namespace.
- **`out_of` from counter:** equals number of distinct docs without reading all
  docs (assert via a spy/log or by trusting the aggregate count matches a
  `documents` collect in a small fixture).
- **Lean text path:** a selective query returns the same `found`/hits/facets as
  the pre-S1 implementation (golden comparison on a fixture), proving correctness
  while not loading the whole collection.
- **Lean browse path:** empty-`q` pagination returns the correct page/`out_of`
  and matches the previous docId-ordered output.
- **Fallback path:** browse + filterBy/facetBy still returns correct results
  (unchanged behavior).
- **Backfill:** after inserting docs "behind" the aggregate, the backfill makes
  `count` correct and is idempotent on re-run.
- Full existing suite stays green (S1 must not change any current result).
