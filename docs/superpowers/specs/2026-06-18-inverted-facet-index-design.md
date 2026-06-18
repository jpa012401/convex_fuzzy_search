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
Mirrors `postingChunks`:

    facetPostings: {
      collection: string,
      field: string,
      value: string,
      bucket: number,            // floor(docKey / 64)
      docKeys: number[],         // sorted, deduped, within this bucket
    }
      .index("by_collection_field_value", ["collection", "field", "value"])
      .index("by_collection_field_value_bucket",
             ["collection", "field", "value", "bucket"])

### 2. Write path — `facetPostings.ts` (new module)
Mirror `postingChunks.ts`'s add/remove/chunk discipline:
- `addFacetPostings(ctx, collection, docKey, facets: {field, value}[])` — for
  each `(field, value)`, load the bucket chunk for `docKey`, insert/patch with
  the docKey added to the sorted `docKeys` array (dedup on docKey).
- `removeFacetPostings(ctx, collection, docKey, facets)` — remove the docKey
  from each `(field, value)` bucket; delete the chunk row when it empties.
- `readFacetPostingDocKeys(ctx, collection, field, value)` — async-generator /
  collector over a value's chunks yielding sorted docKeys (for intersection).
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

- **Unit (`facetPostings.test.ts`):** add/remove/dedup/bucket behavior; chunk
  creation and emptying; sorted invariant.
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
