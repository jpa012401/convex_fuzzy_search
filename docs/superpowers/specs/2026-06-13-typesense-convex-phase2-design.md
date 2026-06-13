# Typesense-style Search Convex Component — Phase 2 Design

**Date:** 2026-06-13
**Status:** PROVISIONAL roadmap spec — to be re-reviewed/refined when Phase 1 is complete
**Scope:** Phase 2 — Filtering (`filter_by`) + Faceting (`facet_counts`)
**Depends on:** Phase 1 (data model, write path, search envelope)

## Goal

Add structured filtering and query-scoped facet counts to the Phase 1 search,
keeping the Typesense-shaped envelope. Filters and facets are **correct within
bounded scale** (match sets within the ~16k query read ceiling); making them
exact at arbitrary scale is Phase 4.

## New Collection Config

Extend `createCollection` (and add `updateCollection`):
- `filterFields: { field: string, type: "string" | "number" }[]` — fields that
  can appear in `filter_by`.
- `facetFields: string[]` — fields that can be faceted.

A field may be both filterable and facetable.

## Data Model Additions

```
filters
  collection: string
  field: string
  docId: string
  strVal?: string        // set when type = string
  numVal?: number        // set when type = number
  // index: by_field_str [collection, field, strVal]   (exact / in)
  // index: by_field_num [collection, field, numVal]    (range scans)
  // index: by_doc       [collection, docId]            (delete / re-index)
```

`upsert`/`delete` (Phase 1 write path) extend to write/remove `filters` rows for
declared `filterFields`, in the same transaction (still synchronous).

## Filter Syntax (`filter_by`) — supported subset

Typesense-compatible subset (YAGNI: add more later if needed):
- Exact: `brand:Apple`
- In (OR set): `brand:[Apple,Samsung]`
- Numeric comparators: `price:>100`, `price:>=100`, `price:<50`, `price:<=50`
- Numeric range: `price:[100..200]`
- Boolean combine: `&&` (AND), `||` (OR), with parentheses.

Parsed into an expression tree; each leaf resolves to a `docId` set via the
`filters` indexes (exact/in via `by_field_str`; comparators/range via
`by_field_num` range scans). AND = intersect, OR = union.

## Search Flow Changes

`search({ ..., filterBy?, facetBy? })`:
1. Compute the text-match `docId` set (Phase 1 AND logic). Empty `q` → all docs.
2. Compute the filter `docId` set from `filterBy` (if present).
3. Intersect → final match set; `found` = its size.
4. **Faceting:** for each `facetBy` field, load the matched docs' values (from
   `filters` rows or `documents.stored`) and tally counts per value. Populate
   `facet_counts` in the Typesense shape:
   ```jsonc
   "facet_counts": [
     { "field_name": "brand",
       "counts": [ { "value": "Apple", "count": 42 }, ... ] }
   ]
   ```
5. Sort (still stable order — ranking is Phase 3), paginate, assemble `hits`.

## Known Limits (Phase 2)

- Filtering, `found`, and facet counts are exact only while the match set is
  within the query read ceiling (~16k). Beyond that is Phase 4 (precomputed
  sharded counters, postings sharding).
- No relevance ranking yet (Phase 3); results still in stable `docId` order.

## Open Questions (resolve at phase start)

- Facet value source: tally from `filters` rows (extra reads) vs. from
  `documents.stored` (already loaded for hits)? Lean toward `stored`.
- `max_facet_values` cap per field (Typesense defaults to 10) — confirm default.
- Whether to support negation (`brand:!=Apple`) in Phase 2 or defer.

## Testing Strategy (TDD)

- Filter parser unit tests: each operator, precedence, parentheses, malformed
  input → clear error.
- Filter resolution: exact, in-set, each comparator, range, AND/OR combinations.
- Faceting: counts reflect the filtered+searched set (not global); multiple
  facet fields; `max_facet_values` cap.
- Write-path: `filters` rows created/replaced/deleted in sync with documents.
- Sample app: enable the facet sidebar (brand/category/price) and filter chips.
