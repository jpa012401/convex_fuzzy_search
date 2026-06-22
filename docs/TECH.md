# FuzzySearch — Technical Documentation (Hybrid Native-Search Architecture)

> **Status:** Rebuilt onto Convex managed `.searchIndex`. Branch `feat/hybrid-native-search`.
> Supersedes the pre-rebuild internals described in `overview.md` (the hand-rolled
> inverted index). The public API and result envelope are unchanged from the prior version.

`@elevatech/fuzzy-search` is a full-text search **component** for [Convex](https://convex.dev).
It runs entirely inside your Convex deployment — there is no external search service. A
document is searchable the instant the indexing mutation commits (verified: native
`.searchIndex` is synchronous-at-commit on Convex 1.41).

This document covers **how it works** and **how to operate it**. For the original design
rationale and the scale review that motivated this architecture, see
`docs/superpowers/plans/2026-06-21-hybrid-native-search-*.md`.

---

## 1. Architecture at a glance

```
        ┌──────────────────────────── YOUR APP ────────────────────────────┐
        │  source-of-truth table (e.g. productDocs)                          │
        │      │  upsert / upsertMany (app table _id = search doc id)        │
        │      ▼                                                             │
        │  new FuzzySearch(components.fuzzySearch, { collections: {...} })   │
        └──────│─────────────────────────────────────────────────────────────┘
               ▼  (client → component, via ctx.runQuery / ctx.runMutation)
   ┌──────────────────────────── COMPONENT ──────────────────────────────────┐
   │  WRITE PATH                          READ PATH                            │
   │  write.ts → projectToSlots →         search.ts → runTextQuery /           │
   │    1 searchDocs row                    runEmptyQFilterQuery                │
   │    + aggregate ops                     → native .searchIndex (.take K)     │
   │    + applyTermDiff (dict)               → reverifyAnd (OR→AND)             │
   │  searchDocs ── 9 native ── s0..s8       → suggestTerms on miss (typo)      │
   │   (generic slots)  search indexes       → resolveFoundAndFacets           │
   │  facetCounts (table)                     → ranking DSL re-rank            │
   │  terms + trigrams (typo dict)            → Typesense envelope (ids+hilite) │
   │  @convex-dev/aggregate: docCount, sortIndex                                │
   └───────────────────────────────────────────────────────────────────────────┘
               ▼  search returns IDS + scores + highlights
        the app HYDRATES serving fields from its own table by id
```

**Core bet:** Convex's *managed* `.searchIndex` does text retrieval (an index structure,
not table rows), so query cost is `O(page)` and **flat with collection size** — it does not
read posting rows. Everything native search cannot do (facet counts, weighted ranking,
multi-key sort) is layered on top via the `@convex-dev/aggregate` component and a small
in-memory re-rank over the bounded candidate window.

**Division of labor:**
- **Native `.searchIndex`** — candidate retrieval (text match, prefix, equality filters), bounded `≤1024`.
- **`@convex-dev/aggregate`** — `out_of`, browse/sort pagination, declared sort specs (O(log n)).
- **`facetCounts` table** — per-value facet counters (bounded by field cardinality).
- **In-memory layers** — AND re-verification, the ranking DSL, facet tally over the candidate window.

---

## 2. The lifecycle (app ↔ component)

The app owns its documents; the component holds only the index + a stored projection.

1. **Declare** collections on the client (pure config, no DB work):
   ```ts
   const search = new FuzzySearch(components.fuzzySearch, {
     collections: {
       products: {
         searchFields: ["name", "description", "brand", "category"],
         storedFields: "derived",      // store only index-relevant fields; app hydrates the rest
         filterFields: [{ field: "brand", type: "string" }, { field: "price", type: "number" }, ...],
         facetFields: ["brand", "category"],
         sortSpecs: [[{ field: "price", order: "asc" }], ...],
         rankProfiles: { /* ... */ },
       },
     },
   });
   ```
2. **Sync** (in a mutation) — `await search.sync(ctx)` reconciles each configured collection
   to a `collections` row. Idempotent, O(1), reads no documents. Creates the row if absent,
   updates metadata in place, and returns `pendingFields` for any newly-added structural field.
   **This is what materializes a collection** — constructing `FuzzySearch` does nothing on its own.
3. **Index** — the app inserts a doc into its own table, then `await search.upsert(ctx, { collection, id, doc })`
   (or `upsertMany`). The app table's `_id` is the search document id.
4. **Search** — `await search.search(ctx, { collection, q, ... })` returns `{ found, hits, facet_counts, ... }`
   where each hit is `{ id, score, highlight }`. The app **hydrates** serving fields from its own
   table: `hits.map(h => ctx.db.get(h.id))`.
5. **Reindex** (after a config change) — replay the app's own table back through `upsert`/`upsertMany`
   in bounded pages, then `search.clearPending(ctx, collection)`. The component never reads the app's corpus.

See `example/convex/products.ts` for a complete working driver.

---

## 3. Data model

The component schema has **six tables** (four core + the two-table typo dictionary):

### `searchDocs` — the generic-slot indexed table
One row per `(collection, docId)`. A fixed pool of generic columns backs nine native search
indexes, so arbitrarily-named runtime fields map onto static index columns.

| Column group | Columns | Purpose |
|---|---|---|
| identity | `collection`, `docId` | tenant scope + app id |
| text | `text0` .. `text8` | `text0` = all searchFields concatenated (space-joined); `text1..8` = one mapped searchField each |
| string filter | `filt0` .. `filt7` | equality-filter slots (native `.eq`) |
| numeric filter | `numF0` .. `numF6` | numeric-filter slots (native `.eq` + in-memory range post-filter) |
| stored | `stored` | the projected fields returned in hits (and used for in-memory ranking/facets) |

**Indexes:** `by_collection_doc` (`["collection","docId"]`) + nine search indexes `s0..s8`
(`sN.searchField = textN`), each declaring the **same shared `FILTER_SLOTS` const** as
`filterFields` so the nine cannot drift.

> **Hard platform limit baked into the slot pool:** a Convex search index allows **≤16
> filterFields**. `FILTER_SLOTS` = `collection`(1) + `filt0..7`(8) + `numF0..6`(7) = **16**, the
> maximum. This caps a single collection at **8 searchable fields, 8 string filters, 7 numeric
> filters**. Declaring more throws at `createCollection`/`sync` time with a cap-naming error.

### `collections` — declarative config + slot map
The synced config per collection (`searchFields`, `filterFields`, `facetFields`, `sortSpecs`,
`rankProfiles`, `pendingFields`) plus a persisted **`slotMap`** — the deterministic
`fieldName → slot` mapping (`{ search, strFilter, numFilter }`). Index: `by_name`.

### `facetCounts` — per-value facet counters
`(collection, field, value) → count`, maintained incrementally on write. Read bounded by
`FACET_VALUE_READ_BUDGET` (200 values), i.e. by field cardinality, not document count.

### `deletions` — teardown bookkeeping
Tracks an in-progress `deleteCollection` so a same-named collection can't be re-created mid-teardown.

### `terms` + `trigrams` — the typo-correction dictionary (§7 typo tolerance)
- **`terms`** — `(collection, term) → docCount`, the distinct-term vocabulary, ref-counted so a
  term is one row regardless of how many documents contain it. Index `by_collection_term`.
- **`trigrams`** — `(collection, gram, term)`, the gram→term bridge for fuzzy candidate lookup.
  Indexes `by_collection_gram` (query-time lookup) + `by_collection_term` (cleanup).

Both are maintained incrementally on write (`termDict.applyTermDiff`, per-document term sets) and
read only at query time for typo correction, **bounded by the candidate budget (≤200 reads) and
scaled by vocabulary, not document count**. They are cleared in bounded batches by
`deleteCollection` (`clearCollectionTermsBatch`). See §7 (typo tolerance) and §5 (read path).

### Aggregate components (separate, via `@convex-dev/aggregate`)
- **`docCount`** — O(log n) collection size (`out_of`) and ordered browse pagination.
- **`sortIndex`** — one composite-keyed entry per declared `sortSpec`, for indexed browse-by-sort
  and the ranking-profile candidate window.

---

## 4. The write path (`write.ts` → `searchWrite.ts`)

`upsert(collection, id, doc)`:
1. `requireCollection` → load the collection row (must be synced first; carries `slotMap`).
2. `clearDoc` — delete any prior `searchDocs` row for this id and reverse its facet-table +
   sort-aggregate entries.
3. `projectToSlots(doc, col)` (`searchWrite.ts`) builds the new row:
   - `text0` = `tokenize()`-joined text of all searchFields; `textN` = the raw text of each
     mapped searchField (native search tokenizes it);
   - `filtN` = `String(value)` of each mapped string filter; `numFN` = `Number(value)` (NaN skipped);
   - `stored` = the projected fields (`storedFields`: `"all"` | `"derived"` | explicit list).
4. Insert **one** `searchDocs` row.
5. Aggregate/table ops: `addDoc` → docCount (new docs only); `incrementFacet`/`decrementFacet`
   on the `facetCounts` table; `addSortEntry`/`removeSortEntry` → sortIndex.
6. `applyTermDiff(oldTerms, newTerms)` (`termDict.ts`) — ref-counts the doc's distinct terms in
   the `terms` dictionary and maintains `trigrams` (adds on a term's first sight, removes at
   docCount 0). `newTerms` = the doc's tokenized searchFields; `oldTerms` = the prior row's terms.

**Cost:** ~1 row write + O(facets + sortSpecs) aggregate ops + a per-document (vocabulary-scale)
dictionary diff — no posting fan-out, no monotonic docKey counter. A single large-text document
can no longer blow the per-mutation write or array-size limits.

**`upsertMany`** processes docs in slices of `UPSERT_MANY_BATCH` (= `floor(3000 / WRITES_PER_DOC)` =
250) and self-schedules `upsertManyChain` via `ctx.scheduler.runAfter` for the remainder — bounded
by total row-writes, not a fixed doc count.

---

## 5. The read path (`search.ts` + `searchRead.ts` + `filterRank.ts`)

`search({ collection, q, page, perPage, queryBy?, filterBy?, facetBy?, sortBy?, rankBy?, rank? })`:

```
if q is empty:
   browse / sort / rank-browse / empty-q+filter branches
     ├─ lean browse / declared sortBy → page off docCount / sortIndex aggregates (no doc reads)
     ├─ browse + facets → readFacetCounts (facetCounts table)
     └─ empty-q + filter → runEmptyQFilterQuery (by_collection_doc, in-memory eq + range post-filter, bounded take)
else (text query):
   pickSearchSlot(queryBy, slotMap) → { indexName, slot }
   resolveEqFilters(filterBy, slotMap) → { eq[], postFilter }       # filterRank.ts
   candidates = withSearchIndex(indexName, b => b.search(slot, q).eq("collection", name).eq(...eq)).take(K≤1024)
   candidates = apply postFilter (ranges / OR / unmapped) in memory  # bounded over ≤K
   candidates = reverifyAnd(candidates, tokenize(q))                 # native is OR → re-impose strict AND

# ordering, found, facets — all over the ≤K Candidate[] in memory:
order:  rank profile → evalTerms(stored, terms, weights, synthScore(rankPos,total), ctx) then sort  (score.ts)
        rankBy/sortBy → orderingScore + compareMatches                                              (ranking.ts)
        else          → native relevance order (synthScore by rank position)
found:  out_of = collectionCount aggregate; text found = reverified candidate count
        (found_approximate=true when the native ≤K window was full)
facets: browse → readFacetCounts (table); query-scoped → tally over candidates (sets found_approximate)
hits:   page slice (1-based) → { id, score, highlight }; highlight via highlightField(stored, tokenize(q))
```

### The single shared candidate type
```ts
type Candidate = { docId: string; stored: Record<string, unknown>; slotText: string; rankPos: number };
```
`slotText` feeds AND re-verification and highlighting; `rankPos` feeds `synthScore`.

### Bounded-reads invariant (enforced everywhere)
**No query or mutation reads a number of rows proportional to collection size.** The allowed
sources of "many": native search `.take(K≤1024)`; aggregate O(log n) node reads; `facetCounts`
read bounded by field cardinality (≤200); a page slice (`perPage ≤ 250`); a re-rank window
(`≤1024`). `deleteCollection`, reindex, and `upsertMany` are paged and `ctx.scheduler`-chained.
`.collect()` on a search query is forbidden (native throws past 1024 anyway).

---

## 6. Public API (the `FuzzySearch` client)

Construct once per app module: `new FuzzySearch(components.fuzzySearch, { collections })`.

| Method | Kind | Purpose |
|---|---|---|
| `sync(ctx)` | mutation | Reconcile configured collections → rows; returns `pendingFields`. Drive once post-deploy. |
| `createCollection(ctx, args)` | mutation | Imperative single-collection create (alternative to config+sync). |
| `getCollection(ctx, name)` | query | The collection row (incl. `slotMap`) or `null`. |
| `pendingFields(ctx, collection)` | query | Structural fields awaiting reindex (empty when fully indexed). |
| `clearPending(ctx, collection)` | mutation | Mark fully reindexed (after replaying all docs). |
| `deleteCollection(ctx, name)` | mutation | Batched, self-scheduling teardown (safe at any size). |
| `upsert(ctx, { collection, id, doc })` | mutation | Index/replace one document. |
| `upsertMany(ctx, { collection, docs })` | mutation | Bulk index (write-bounded, scheduler-chained). |
| `delete(ctx, { collection, id })` | mutation | De-index one document. |
| `stats(ctx, collection)` | query | Index health: `out_of`, per-facet counts, sort-spec counts. |
| `search(ctx, args)` | query | The search query (see signature below). |

### `search` arguments
```ts
{
  collection: string;
  q: string;                                   // "" = browse
  page?: number;                               // 1-based, default 1
  perPage?: number;                            // default 10, max 250
  queryBy?: string[];                          // restrict to specific searchFields (single field → its slot index)
  filterBy?: string;                           // DSL: field:value, field:[a,b], field:[lo..hi], field>=n, &&, ||, ()
  facetBy?: string[];                          // declared facet fields to count
  maxFacetValues?: number;                     // default 10
  rankBy?: { text?: number; fields?: { field: string; weight: number }[] };  // ad-hoc weighted blend
  sortBy?: { field: string; order: "asc" | "desc" }[];                       // multi-key sort
  rank?: { profile: string; weights?: Record<string, number>;                // declared ranking profile
           context?: { now?; origin?: {lat,lng}; sets?: Record<string,string[]> } };
}
```

### Result envelope (frozen — unchanged from the prior version)
```ts
{
  found: number;                 // matched-set size (see found_approximate)
  found_approximate: boolean;    // true when the ≤1024 native window was full, or facets are candidate-scoped
  reranked: boolean;
  page: number;
  out_of: number;                // collection size (docCount aggregate)
  hits: { id: string; score: number; highlight: Record<string, {snippet, matched_tokens}> }[];
  facet_counts: { field_name: string; counts: { value: string; count: number }[] }[];
}
```

---

## 7. Supported features

| Capability | Backed by |
|---|---|
| Tokenized full-text search, multi-word **AND** | native `.searchIndex` (OR) + app-side `reverifyAnd` |
| Prefix / search-as-you-type (last token) | native search |
| Typo tolerance — misspelled token corrected then re-searched (on miss) | `termDict.ts` `suggestTerms` (trigram dictionary + bounded Levenshtein within `typoBudget`); see §9.1 for limits |
| Filtering — exact, in-set, numeric comparators/ranges, `&&`/`||`/parens | `filterRank.ts` (native `.eq` push-down + in-memory residual `Predicate`) |
| Faceting / facet counts | `facetCounts` table (browse) + candidate-window tally (query-scoped) |
| Multi-key sort (`sortBy`) over numeric fields / `_text_match` | `sortIndex` aggregate |
| Weighted ranking (`rankBy`) — blend relevance with numeric fields | `ranking.ts` |
| Ranking profiles (`rank`) — `field`, `flag`, `setBoost`, `recencyDecay`, `geoDistance`, `relevance` | `score.ts` `evalTerms`, windowed re-rank over ≤K |
| Highlighting — `{ snippet, matched_tokens }`, `<mark>`-wrapped, HTML-escaped | `highlight.ts` |
| `found` / `out_of` / pagination | aggregate counts |
| Collections, config sync, reindex/backfill | `configSync.ts` / `collections.ts` |

---

## 8. Scale characteristics

The rebuild's reason for existing. Read cost is independent of collection size:

| Path | Cost | Notes |
|---|---|---|
| Text search | native index lookup + ≤K candidate ops | **flat** with collection size; no posting reads |
| `out_of` / browse paging | O(log n) aggregate | no scan |
| Filtered/faceted search | ≤K candidates + bounded facet read | no read-amplification on hot values |
| Write (per doc) | ~1 row + O(facets+sorts) aggregate ops | no posting fan-out; large docs safe |
| `deleteCollection` | batched + self-scheduling | safe at any size |

**Validated:** seeded **5,006 documents** on a local backend through the full lifecycle; text
search (`found: 86`), filter+facet (`category:Electronics` → `found: 13` with per-brand counts),
text+filter (`found: 24`), and **typo correction** (`"runing"` → corrected to `running` →
`found: 86`) all correct; all three sort specs report `count: 5006`.

**Throughput caveat:** the strongest write win is removing the single hot docKey counter, so
concurrent ingest scales far better than before. The remaining contention is a single dominant
facet **value** (e.g. `status:"active"` on a large fraction of docs) sharing one aggregate
B-tree leaf — mitigated by namespacing + `maxNodeSize`, not eliminated (no sharded-counter
component is installed).

**Latency is flat with collection size, not doc-count.** Because every read is bounded
(≤K candidates, aggregate counts), per-query latency is ~constant from 5k to millions of docs —
that is the rebuild's core guarantee. The heaviest shapes are the **custom-order browse** paths
(`rankBy` / undeclared `sortBy` with no text/filter), which load and re-rank the candidate window
**in memory**.

**The re-rank window is the latency/accuracy knob** for those shapes (`search.ts`):
`DEFAULT_RERANK_WINDOW = 200`, `MAX_RERANK_WINDOW = 1000`, `CUSTOM_ORDER_WINDOW = 200`; a ranking
profile may set its own `window` (clamped to `MAX_RERANK_WINDOW`). Bigger window = more accurate
ordering over more candidates but more in-memory work per query; smaller = faster but the ordering
covers fewer docs (and `found_approximate` is set to signal the result is window-bounded). These
constants are where you trade ranking depth for latency.

**Measuring it.** `products:benchmark` reports single-query latency + correctness signals per
query shape. `products:concurrencyBenchmark` fires N queries in parallel and reports p50/p95/p99 +
effective QPS — this is what reflects the deployment's **concurrency class**: Convex **S16** runs
at most 16 concurrent queries, so beyond ~16 in-flight, queued queries inflate p99/max (each
query's own latency is unchanged — the queue is the bottleneck). Single-query latency does not
depend on the class; throughput does. Run e.g.
`npx convex run products:concurrencyBenchmark '{"concurrency":32,"rounds":3}'`.

> **Local vs. hosted (S16):** a local backend has no app→deployment network hop, but Convex hosts
> co-locate function + DB (sub-ms reads, ~10ms warm isolate), so local single-query timings are a
> reasonable proxy for S16 per-query latency. The real production difference is the **16-concurrent
> ceiling** (a throughput limit, addressed by S256/D1024), not per-query speed.

---

## 9. Known limitations & deliberate trade-offs

These are the price of native retrieval; all are intentional and documented.

1. **Typo tolerance is query-side correction, with edit-distance limits.** Native search itself
   does **not** match misspellings (native fuzzy is being deprecated), so typo tolerance is
   provided by a **query-side suggest-then-search** layer (§7, `termDict.ts`): on a search miss, a
   typo'd token is corrected to a near-by corpus term via the trigram dictionary + bounded
   Levenshtein within `typoBudget`, then native search re-runs with the corrected term. Residual
   limits: (a) correction follows the per-length budget (`≤3` chars → 0 typos, `≤7` → 1, else 2),
   and **transpositions count as 2 edits** under plain Levenshtein (so `jacekt`→`jacket` is
   distance 2, often below the trigram-overlap threshold and not corrected — same behavior as the
   old engine); (b) the dictionary is built on write, so documents indexed before this layer
   existed need a re-upsert before their terms are suggestible; (c) correction runs **on miss
   only**, so a typo that happens to also be a valid prefix/term is not "corrected" away.
2. **Relevance score is synthesized, not the exact scale.** Native search returns rank order with
   **no score**. `hit.score` is synthesized from rank position (`synthScore(rankPos, total)`), so
   the old `exact=3 / prefix=2 / typo=2−0.5d` scale is gone. Existing `rankProfiles` that depended
   on the absolute relevance number need re-tuning; relative ordering is preserved.
3. **OR-by-relevance, re-imposed as AND app-side.** Native search returns docs matching *any*
   query word; the component re-verifies AND over the ≤K candidate window. If a selective
   multi-token query's true AND-matches fall outside native's top-1024-by-relevance, the page can
   under-fill — flagged via `found_approximate`.
4. **`found` / facets above 1024 are candidate-bounded.** A query matching more than the ~1024
   native window reports `found` as a floor with `found_approximate: true`; query-scoped facet
   counts are tallied over that relevance-biased window. Exact totals come from the aggregate, not
   from enumerating matches.
5. **Per-collection field cap.** 8 searchable fields, 8 string filters, 7 numeric filters (the
   16-filterField search-index limit). Over-cap throws at config time.
6. **Numeric ranges are a post-filter.** Native `filterFields` are equality-only; ranges
   (`price:[100..200]`, `price>=50`) run as an in-memory `Predicate` over the candidate window.
7. **Native indexing is synchronous-at-commit** (verified on 1.41) — instant searchability is
   preserved. (If a future Convex version made it async, instant consistency would weaken.)
8. **Prefix matching has a minimum prefix length.** Native `.searchIndex` only expands the last
   token as a prefix once it is long enough (~5 chars on the local backend; e.g. `jacke`→`jacket`
   matches, `jack` returns nothing). Below that floor native returns no candidates, so very short
   search-as-you-type fragments don't match. `reverifyAnd` correctly preserves prefix semantics on
   the last token *wherever native returns candidates* (so multi-token prefix queries like
   `"rain jacke"` work) — the floor is a native-platform characteristic, not an app-side one.

---

## 10. Operations

- **Deploy / push:** `npx convex dev` (or `--once` for one-shot). Local backend:
  `npx convex deployment select local` then `npx convex dev`.
- **Seed (example app):** `products:seed` (small sample); for bulk, ensure the collection is
  synced, then drive `products:seedChain` (self-chaining batches of `MAX_COMPONENT_BATCH`).
- **Reindex after a config change:** `search.sync` flags `pendingFields`; replay the app's own
  table through `upsert`/`upsertMany` in bounded pages, then `search.clearPending`.
- **Tear down a collection:** `search.deleteCollection` (batched + self-scheduling; safe at scale).
- **Index health:** `search.stats(ctx, collection)` → `out_of`, facet counts, sort-spec counts;
  for a fully-indexed collection every sort-spec `count` equals `out_of`.

---

## 11. Module map

| Concern | Module |
|---|---|
| Schema (6 tables, 9 search indexes, `FILTER_SLOTS`, validators) | `schema.ts` |
| Field→slot assignment (`assignSlots`, `SLOT_LIMITS`, over-cap throw) | `slotMap.ts` |
| Write: doc → slot row | `searchWrite.ts` (`projectToSlots`) |
| Write path (upsert / upsertMany / delete) | `write.ts` |
| Read helpers (`Candidate`, `reverifyAnd`, `synthScore`, `pickSearchSlot`, `runTextQuery`, `runEmptyQFilterQuery`, `loadStored`, `resolveFoundAndFacets`, `clampK`) | `searchRead.ts` |
| Filter/rank resolvers (`resolveEqFilters`, `resolveRankProfile`) | `filterRank.ts` |
| Search query handler | `search.ts` |
| Filter DSL parser (`parseFilterAst`, `astToPredicate`) | `filter.ts` |
| Ranking DSL (`evalTerms`, term types) | `score.ts` |
| Sort/relevance comparators (`orderingScore`, `compareMatches`, `numField`) | `ranking.ts` |
| Highlighting | `highlight.ts` |
| Tokenizer (`tokenize`, `trigrams`) | `tokenizer.ts` |
| Typo dictionary: write-maintenance (`applyTermDiff`) + query-side correction (`suggestTerms`) | `termDict.ts` |
| Typo primitives (`typoBudget`, bounded `levenshtein`) used by `termDict` | `fuzzy.ts` |
| Counts/pagination aggregate | `counters.ts` |
| Sort aggregate | `sortIndex.ts` |
| Facet counters (table) | `facetCounts.ts` |
| Collections + teardown | `collections.ts` |
| Config sync + reindex flags | `configSync.ts`, `diffCollection.ts` |
| Stored-field projection | `storedFields.ts` |
| Index-health stats | `stats.ts` |
| Client (app-facing `FuzzySearch`) | `src/client/index.ts` |
