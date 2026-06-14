# Phase 4 · S3 — Aggregate Facet Counters — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Scope:** Maintain exact per-value facet counts in the write path so global facet counts are an O(cardinality) read, removing the last full-collection load (browse + facets, no filter, no text).
**Part of:** Phase 4 indexed-retrieval program (S3 of S1→S5). Depends on S1 (doc-count aggregate + lean reads) and S2 (indexed filtering).

## Problem

After S2, every filtered or text query loads only its bounded matched set. The one remaining query that loads the **entire** collection is **browse + facets with no filter and no text** (`search.ts` "BROWSE + facets/custom-order but NO filter" branch): it full-loads `documents` purely to (a) tally facet counts and (b) produce the page. S3 eliminates that scan for the no-custom-order case by serving facet counts from a write-maintained counts table and paging hits off the doc aggregate.

## Decision: a dedicated `facetCounts` table (not @convex-dev/aggregate)

Facet rendering needs "all distinct values of field F, with their counts, top N by count." That is **value enumeration**, which a plain counts table answers directly via an index scan bounded by cardinality. `@convex-dev/aggregate` is optimized for offset/rank/sum over a key, not for enumerating distinct keys, so it is the wrong tool here. The doc-count aggregate from S1 is still used (for `out_of` and for paging the lean browse+facets hits); S3 only adds the facet table.

Cardinality (distinct brands/categories/etc.) is tiny relative to document count, so reading every value row for a field is cheap and exact.

## Data model

New table, maintained in the write path for **declared `facetFields`** only:
```
facetCounts
  collection: string
  field: string
  value: string
  count: number
  index by_field  [collection, field]           // enumerate all values for a field
  index by_value  [collection, field, value]     // locate the row to increment/decrement
```
- One row per `(collection, field, value)` that currently has ≥ 1 document. `count` is the number of documents in the collection whose stored `field` stringifies to `value`.
- Value is `String(raw)` (same coercion as in-memory faceting today). Missing/`null`/`undefined` field values contribute no row (consistent with current facet tally, which skips them).

## Write-path maintenance (`write.ts`)

Mirror the S2 filter-row lifecycle, for declared `facetFields`:
- **Upsert (replace semantics):** for each declared facet field, compute old value (from the doc being replaced, if it existed) and new value. If unchanged, no-op. Otherwise `decrement(old)` and `increment(new)`.
  - `increment(collection, field, value)`: find the `by_value` row; if present `count += 1`, else insert `{count: 1}`.
  - `decrement(collection, field, value)`: find the `by_value` row; `count -= 1`; if it reaches 0, delete the row (no zero-count rows kept).
- **Delete:** for each declared facet field the doc had a value for, `decrement(value)`.
- **deleteCollection:** delete all `facetCounts` rows for the collection (added to the existing per-table cleanup in `collections.ts`, paged the same way as the other index tables).

Helpers live in a small focused module (e.g. `src/component/facetCounts.ts`): `incrementFacet`, `decrementFacet`, `readFacetCounts(ctx, collection, field, maxValues)`, `clearCollectionFacets(ctx, collection)`. `write.ts` calls increment/decrement; `search.ts` calls `readFacetCounts`; `collections.ts` calls `clearCollectionFacets`.

## Search integration (`search.ts`)

Two changes; everything else is unchanged.

1. **New lean path — browse + facets, no filter, no text, no custom order.** When `tokens.length === 0 && !hasFilter && hasFacets && !hasCustomOrder`:
   - `out_of`/`found` come from the doc-count aggregate (`found === out_of`).
   - Page the hits off the doc aggregate (`pageDocIds` at `(page-1)*perPage`), `loadDocs` only those.
   - `facet_counts`: for each requested (declared) facet field, `readFacetCounts` returns the top `maxFacetValues` rows sorted **count desc, value asc** — identical ordering to the in-memory tally today.
   - No full-collection load.

2. **Query-scoped facets (filter or text present): unchanged.** Facets are still tallied in-memory over the S2-bounded matched set, exact for the current query context (Typesense-style query-scoped facet counts). This is the correct behavior — global counters do not reflect an active filter/query.

The existing pure-lean-browse path (no facets) and all filter/text paths are untouched.

## Policy (decided)

- Global facets (no filter, no text) → exact, served from `facetCounts`.
- Query-scoped facets (filter or text present) → exact, tallied in-memory over the bounded matched set.
- The very-broad-filter case (a single filter matching into the millions, where even the bounded matched set exceeds the per-query read budget) is **deferred**. No approximation and no `facet_counts_approximate` flag is introduced in S3 — the envelope shape is unchanged.

## Backfill / migration

`facetCounts` is empty for documents indexed before S3. Provide an idempotent **facet-count backfill**: a paginated mutation over `documents` (manual cursor paging — `ctx.db.query().paginate()` is app-only and throws inside a component) that re-derives each doc's declared facet values and increments the counts. Batch size chosen so total reads/writes per page stay under the 4096-read limit (each doc touches ~`facetFields.length` counter rows, so batch ≈ 100 as in S2). Exposed on the client as `backfillFacetCountsPage`, driven from the example like the S1/S2 backfills.

**Idempotency:** running the backfill twice would double-count. To stay idempotent, the backfill first clears the collection's `facetCounts` rows (page-bounded) on the first page (cursor === start), then accumulates — OR the driver clears once before paging. The plan will specify a single clear-then-rebuild so re-running is safe.

Until backfilled, global (unfiltered browse) facet counts under-report pre-S3 docs; query-scoped facets are unaffected (still computed in-memory).

## Known limits after S3

- Array-valued facet fields still deferred (single stringified value per field).
- Query-scoped facets over a very broad filter still tally in-memory (bounded by the matched set; extreme-breadth cap deferred).
- Sorting still in-memory over the matched set (S4 adds fixed-field sort indexes).
- Hot common search terms still load all postings (S5).

## Testing strategy (TDD)

- **`facetCounts.ts` helpers:** increment creates then bumps a row; decrement lowers and deletes at zero; `readFacetCounts` returns top-N sorted count desc / value asc; multi-field and multi-collection isolation.
- **Write path:** upsert of a new doc increments each declared facet value; replace with a changed facet value decrements old + increments new (no orphan, no double count); replace with unchanged value is a no-op; delete decrements; deleteCollection clears all rows; missing/null facet value contributes no row.
- **Search — global path:** browse + facets, no filter/text, returns the same `facet_counts` as the pre-S3 in-memory tally (golden) **without** loading the whole collection; paging hits still correct.
- **Search — query-scoped unchanged:** filter+facets and text+facets return identical results to S2 (exact over matched set).
- **Backfill:** rebuilds counts for pre-existing docs to match a freshly-seeded collection; idempotent (running twice yields identical counts).
- Full existing suite stays green (all facet results identical for every covered case).
