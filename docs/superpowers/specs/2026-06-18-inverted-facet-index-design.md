# Inverted Facet Index (Facet Postings) — Design

**Date:** 2026-06-18
**Status:** Approved
**Branch:** `feat/inverted-facet-index`

## Goal

Make **filtered facet counts** (the `filter + facet` query path) exact, general
over any filter shape, and cheap — computed by intersecting sorted docKey
posting lists instead of loading every matched document. This removes the
4096-reads-per-query throw and the 8.5s latency on `boolean+facet`.

## Problem

The `filter + facet` path loads **all** matched docs (`loadDocs(matchedIds)` in
[search.ts](../../../src/component/search.ts), the `filterIds` branch) to tally
facet values in memory. At ~4000 matched docs that is ~4000 reads on top of the
~4000-read filter resolve — it throws "Too many reads" (hard limit 4096) and
takes ~8.5s.

The maintained `facetCounts` table holds only **global** per-value counts, which
cannot answer "count *within this filter set*." A combinatorial
`(filterValue × facetValue)` aggregate does not generalize to AST filters
(ranges, AND/OR). The correct fix is a data-model change, not a patch.

## Core idea: facets as inverted posting lists

The component already stores **terms** inverted: `term → sorted list of docKeys`,
chunked into buckets of `POSTING_CHUNK_SIZE` (64) in `postingChunks`. A facet
value is structurally identical: `(field, value) → sorted list of docKeys`.

A filtered facet count then becomes a **sorted-list intersection**:

    count(field=V within filter) = | docKeys(field=V)  ∩  filterDocKeys |

Both sides are sorted numeric docKey lists, so this is a linear merge-walk — no
document loads. Read cost = the posting chunks of the filter side plus the facet
field's posting chunks (hundreds of chunk reads for thousands of docs), not
thousands of per-doc reads.

## Key decisions (approved)

- **Key by `docKey` (numeric), not docId.** Sorted integer lists are required
  for the merge-intersection and match `postingChunks`. The filter side is
  resolved/mapped into docKey space.
- **Full inverted index, not a patch.** New table + write maintenance +
  read path + backfill + teardown — comparable in scope to the existing
  posting-chunk work.
- **Keep `facetCounts` (forward, global).** It still serves the cheap
  unfiltered browse-facet path; this design only changes the *filtered* path.

## Components

### 0. Schema — add `docKey` to `filters` (prerequisite)
The filtered-facet intersection runs in docKey space, so the filter resolve must
return docKeys. Add `docKey: number` to the `filters` table (written from the
doc's existing `docKey`, alongside the current `docId`). Update `rowsToResult`
and the resolve helpers in [filter.ts](../../../src/component/filter.ts) to carry
docKeys. `docId` stays (still used elsewhere); this is additive. Existing rows
get `docKey` via the backfill (§5). Until backfilled, a `filters` row lacking
`docKey` marks the index incomplete → the read path falls back (§5).

### 1. Schema — new table `facetPostings`
Mirrors `postingChunks` structurally, but uses **fill-based bucketing** (pack the
tail bucket to capacity before opening a new one) rather than
`postingChunks`'s fixed `floor(docKey/64)` ranges:

    facetPostings: {
      collection: string,
      field: string,
      value: string,
      bucket: number,            // monotonic append-order index, NOT docKey/64
      docKeys: number[],         // sorted, deduped; up to FACET_CHUNK_SIZE (64)
    }
      .index("by_collection_field_value", ["collection", "field", "value"])
      .index("by_collection_field_value_bucket",
             ["collection", "field", "value", "bucket"])

**Fill-based bucketing (the requested behavior).** A new docKey is appended to
the **current tail** bucket for its `(field, value)` — the highest existing
`bucket`, found via `by_collection_field_value_bucket` ordered desc, `.first()`.
- If no bucket exists, create bucket `0` with the single docKey.
- If the tail bucket has `< FACET_CHUNK_SIZE` docKeys, insert the docKey into its
  sorted `docKeys` (dedup) and patch.
- If the tail bucket is full (`=== FACET_CHUNK_SIZE`), create bucket `tail + 1`.

This guarantees every bucket except the tail is full, so a value with K docs uses
`ceil(K / 64)` chunks — the dense packing this design wants (vs. the sparse
`~3.5 chunks/doc` the `postingChunks` TODO records for the fixed scheme).

**Tradeoff — write contention (documented, accepted).** Fill-based packing means
concurrent writes to the same `(field, value)` contend on the one tail chunk row
(OCC conflict), unlike fixed bucketing where different docKeys land in different
chunks. This is acceptable here because the dominant write path is **sequential**
(`seedChain` self-chains one batch-transaction at a time; `upsertMany` writes
within a single transaction), so same-tail concurrency is rare. Independent
app-driven `upsert` races are handled by Convex's automatic OCC retry. Removals
delete the docKey from whichever bucket holds it (located via the value's chunks);
a bucket that empties is deleted. Removals do **not** compact/rebalance non-tail
buckets — they may fall below full over a doc's lifetime; density is a write-time
invariant, not a maintained one. Intersection/counting is unaffected by bucket
fill level (it reads all of a value's chunks regardless).

### 2. Write path — `facetPostings.ts` (new module)
Mirror `postingChunks.ts`'s module shape, but with **fill-based** add:
- `addFacetPostings(ctx, collection, docKey, facets: {field, value}[])` — for
  each `(field, value)`, find the tail bucket (highest `bucket`,
  `by_collection_field_value_bucket` desc `.first()`); append to it if it has
  `< FACET_CHUNK_SIZE` docKeys (sorted, dedup), else open `tail + 1`; create
  bucket `0` if none exists. (Per §1.)
- `removeFacetPostings(ctx, collection, docKey, facets)` — for each
  `(field, value)`, locate the bucket containing `docKey` (scan the value's
  chunks), remove it; delete the chunk row when it empties. No rebalancing.
- `FACET_CHUNK_SIZE = 64` constant (own constant; do not couple to
  `POSTING_CHUNK_SIZE`).
- `readFacetPostingDocKeys(ctx, collection, field, value)` — collector over a
  value's chunks returning its docKeys. NOTE: with fill-based bucketing, docKeys
  are sorted *within* a bucket but **not** guaranteed sorted *across* buckets
  (a bucket holds whatever docKeys arrived while it was the tail). The
  intersection therefore treats the result as a **set membership test**
  (smaller-side iterated against the other as a `Set`), not an order-dependent
  sorted merge — so cross-bucket order is irrelevant to correctness.
- `facetValuesForField(ctx, collection, field)` — the distinct values of a
  facet field. Reuse the existing `facetCounts` `by_field` index (already
  maintained, already bounded by `FACET_VALUE_READ_BUDGET`) to enumerate values
  without scanning postings.

`write.ts` `upsertInternal`/`clearDoc` call add/remove for `col.facetFields`,
computing `(field, value)` from the doc exactly as the existing
`incrementFacet`/`decrementFacet` calls do (same `String(raw)` coercion, same
skip on `undefined`/`null`). The forward `facetCounts` writes stay — both are
maintained.

### 3. Read path — filtered facet counts in `search.ts`
In the `filter + facet` case (and `text + filter + facet`):
- Resolve the filter to its matched **docKey** set once, directly. This requires
  the filter resolve to yield docKeys, not docIds (see §0) — otherwise mapping
  docIds→docKeys would itself cost O(filter-set-size) reads and reintroduce the
  problem this design solves. With `docKey` stored on each `filters` row, the
  existing resolve (`strIds`/`numEqIds`/`numCmpIds`/`numRangeIds`,
  intersection/union) returns docKeys at no extra read cost.
- For each requested facet field: enumerate its values
  (`facetValuesForField`), and for each value intersect its posting docKeys with
  the filter docKey set, counting overlaps. Sort desc, take `maxValues`.
- **No `loadDocs` for facet tallying.** The page's docs are still loaded for
  hits/highlighting (bounded to the page, as the text path already does).

### 4. Config rule
Index intersection needs the facet field enumerable and posting-backed, which it
is for every facet field (postings are maintained for all `facetFields`). **No
new config constraint** — unlike the earlier aggregate idea, this does not
require facet ⊆ filter. Drop that rule from consideration.

### 5. Backfill (existing collections)
Existing collections have `facetCounts` but no `facetPostings`. Add a backfill
that replays docs (app-driven, like the existing reindex path) to populate
`facetPostings`, and mark the facet-posting index pending until complete. The
filtered-facet read path must tolerate an absent/partial index by falling back
to the current load-and-tally **only when the index is known-incomplete**, so a
mid-backfill collection never returns wrong counts.

### 6. Lifecycle (mirror `postingChunks` everywhere it appears)
Add `facetPostings` to: `hasCollectionIndexRows`, `deleteCollectionRowsBatch`
(teardown batch), and any index-health/stats enumeration in
[collections.ts](../../../src/component/collections.ts).

## Read-cost summary

| query | before | after |
|-------|-------:|------:|
| boolean+facet (4000 matched, 12 values) | ~8000 reads, throws/8.5s | filter postings + facet postings ≈ a few hundred chunk reads, exact |

## Testing

- **Unit (`facetPostings.test.ts`):** add/remove/dedup/sorted invariant; and the
  **fill-based bucketing** specifically — adding > FACET_CHUNK_SIZE docKeys to one
  `(field, value)` produces `ceil(K/64)` buckets with all-but-tail full; the tail
  fills before a new bucket opens; removal empties and deletes a bucket; a value
  with K docs never creates a sparse non-tail bucket on a sequential add sequence.
- **Intersection correctness:** a filtered facet count equals the brute-force
  count over the same docs, across AST filter shapes (equality, range, AND/OR).
- **Parity:** for a small collection, the new filtered-facet path returns
  identical `facet_counts` to the old load-and-tally path (pin behavior).
- **Lifecycle:** `deleteCollection` removes all `facetPostings`; a re-created
  collection has none leftover.
- **Backfill:** a collection seeded before the index exists yields correct
  filtered counts after backfill; mid-backfill falls back rather than under-counts.
- Full `npm test` green, 0 type errors. Cloud-dev benchmark: `boolean+facet`
  no longer throws and drops to low-ms with correct `found`/counts.

## Scope boundaries (out)

- The global/unfiltered browse-facet path (`facetCounts` table) is unchanged.
- The text-path page-load fix (already merged) is unchanged.
- No change to filter resolution semantics or the filter AST.

## Success criteria

- `facetPostings` table maintained on write; teardown and health checks include it.
- Filtered facet counts computed by sorted-docKey intersection — no `loadDocs`
  for tallying.
- `boolean+facet` (and `text+filter+facet`) exact, no throw, low-ms on cloud at 5k.
- Backfill populates existing collections; partial index never returns wrong counts.
- All tests green; benchmark confirms.
