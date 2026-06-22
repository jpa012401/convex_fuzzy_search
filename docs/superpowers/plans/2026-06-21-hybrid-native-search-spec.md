# Hybrid Native-Search Rebuild — Spec

**Branch:** `feat/hybrid-native-search`
**Date:** 2026-06-21
**Status:** Spec (the WHAT and WHY). A task-by-task TDD implementation plan follows from this.
**Companion:** [2026-06-21-hybrid-native-search-redesign-proposal.md](./2026-06-21-hybrid-native-search-redesign-proposal.md) (the decision + measured Phase-0 facts).

---

## 1. Goal

Replace the component's hand-rolled inverted index with Convex's **managed `.searchIndex`** for text retrieval, keeping the ranking DSL / facet counts / sort / Typesense envelope as thin layers on top — so search latency is **flat with collection size** instead of growing until it hits the 4,096-read wall.

**Non-goal:** changing the public client API or result envelope. The consuming app should see the same `search()`/`upsert()`/`stats()` surface and the same `{ found, hits, facet_counts, … }` shape.

---

## 2. Why (one paragraph)

A table-backed inverted index reads one row per posting, so producing even a small page costs `O(matched docs)` reads — a common term at 1M docs is ~15,600 chunk reads and **throws**. A managed `.searchIndex` is maintained by Convex and queried in ~log time: producing a page costs `O(page)`, flat regardless of collection size. The user's requests stay **under ~1000 docs** (page ≤ 250, re-rank window ≤ 1000), which sits *below* native search's measured 1024 cap — so native's main limitation never binds, while its scaling benefit applies fully.

---

## 3. Verified ground truth (measured on Convex 1.41 — do not re-litigate)

From the Phase-0 probe (now reverted) and source inspection:
- `.searchIndex` is **synchronous at commit** — a doc is searchable in the same transaction as its insert. **Instant consistency is preserved.**
- Native search is **OR-by-relevance**, **caps at 1024 results and THROWS** (does not truncate), returns **no `_score`**, and `filterFields` are **`.eq()` only**.
- `withSearchIndex(...)` returns an `OrderedQuery` → can chain `.eq()`, `.take(K≤1024)`, `.paginate()`, `.filter()`.
- One `searchField` per index; ~16 search indexes per table. Native fuzzy is being **deprecated** (prefix matching is not).
- `@convex-dev/aggregate` (installed) gives O(log n) count/at/paging; **no sharded-counter mode** — a single dominant value still contends on one B-tree leaf.

---

## 4. The central design problem: runtime fields ↔ static native schema

Collections are **runtime rows** (`createCollection`/`sync` define `searchFields`, `filterFields`, `facetFields` at runtime). Native `.searchIndex` columns are **static, declared at deploy time**, one `searchField` each, ~16/table. These cannot meet directly. The bridge:

### Generic-slot schema
A single component `searchDocs` table with a **fixed pool of generic indexed columns**, plus a runtime **mapping** from each collection's named fields onto slots.

```ts
// src/component/schema.ts (new core table — replaces documents/docTerms/postingChunks/
// terms/trigrams/filterPostings/facetPostings/facetCounts/docKeyCounters)
searchDocs: defineTable({
  collection: v.string(),
  docId: v.string(),
  // Generic searchable text slots. text0 = concatenation of ALL searchFields
  // (the no-queryBy fast path); text1..textN = one mapped searchField each.
  text0: v.optional(v.string()),
  text1: v.optional(v.string()),
  text2: v.optional(v.string()),
  text3: v.optional(v.string()),
  text4: v.optional(v.string()),
  // Generic equality-filter slots (string). Numeric filters reuse strN via a
  // sortable encoding OR live as real numeric columns numF0..numF3 for ranges.
  filt0: v.optional(v.string()),
  filt1: v.optional(v.string()),
  filt2: v.optional(v.string()),
  filt3: v.optional(v.string()),
  // Stored projection returned in hits (unchanged concept; storedFields.ts kept).
  stored: v.any(),
})
  .index("by_collection_doc", ["collection", "docId"])
  // One native search index per text slot, each exposing the filter slots + collection
  // as equality filterFields so a search is always scoped to one collection.
  .searchIndex("s0", { searchField: "text0", filterFields: ["collection", "filt0", "filt1", "filt2", "filt3"] })
  .searchIndex("s1", { searchField: "text1", filterFields: ["collection", "filt0", "filt1", "filt2", "filt3"] })
  .searchIndex("s2", { searchField: "text2", filterFields: ["collection", "filt0", "filt1", "filt2", "filt3"] })
  .searchIndex("s3", { searchField: "text3", filterFields: ["collection", "filt0", "filt1", "filt2", "filt3"] })
  .searchIndex("s4", { searchField: "text4", filterFields: ["collection", "filt0", "filt1", "filt2", "filt3"] }),
```

> Slot counts (`text0..4`, `filt0..3`) are the **initial** pool — the spec fixes the *pattern*, not the exact numbers. Final counts are a Task-1 decision bounded by the ~16-index/table limit. `collection` is itself a `filterField` so every search is `.eq("collection", name)`-scoped — this is what makes one physical table safely multi-tenant.

### Mapping layer
`collections.ts`/`configSync.ts` (kept) gain a deterministic map: collection field name → slot. Stored on the collection row:
```ts
slotMap: {
  searchFields: { title: "text1", body: "text2", ... },  // + text0 always = all concatenated
  filterFields: { brand: "filt0", category: "filt1", ... },
}
```
- Assignment is **deterministic and stable** (first-declared → lowest free slot) so re-`sync` is idempotent.
- **Per-collection field cap** = number of slots. Declaring more searchable/filterable fields than slots is a **hard error at `createCollection`/`sync` time** (replaces today's silent truncation). The error names the cap.
- Numeric range filters: a small fixed pool of real numeric columns (`numF0..numF3`) declared as `filterFields` give `.eq`; ranges that native can't do (`.eq` only) fall back to **post-`.filter()` over the ≤K candidates** or an **aggregate range scan** — both bounded.

---

## 5. Component-internal architecture

```
upsert(collection, docId, doc):
  project doc -> stored (storedFields.ts, kept)
  resolve slotMap; write ONE searchDocs row:
     text0 = tokenize+join(all searchFields); text1.. = each mapped searchField raw text
     filt0.. = mapped filter field values; numF0.. = mapped numeric filter values
  aggregate ops: out_of (per collection), facet counts (per [collection, field]),
     declared sort specs (per [collection, specId])  -- @convex-dev/aggregate, kept
  -> ~1 row write + O(facets+sorts) aggregate ops. No docKey counter. No posting fan-out.

search(collection, q, page, perPage<=250, queryBy?, filterBy?, facetBy?, sortBy?, rank?):
  if q empty -> browse/sort/rank branches off aggregates (largely kept as-is)
  else:
    pick search index: queryBy single field -> its slot; else s0 (text0 all-text)
    candidates = withSearchIndex(idx, b => b.search(slot, q).eq("collection", name)
                    .eq(<mapped filter slots from filterBy>...))   // native equality narrows
                    .take(K)                                        // K = clamp(rerankWindow, <=1024)
    candidates = applyRangeFilters(candidates, filterBy)           // post-filter for ranges only
    candidates = reimposeAND(candidates, tokenize(q))              // native is OR -> keep all-token docs
    score(id)  = rankProfile ? evalTerms(stored, synthScore(rankPos), ctx)   // score.ts kept
                             : synthScore(rankPos)                  // synth from native rank order
    order candidates by score; page = slice(page, perPage)
    found       = aggregate-or-candidate (see §6); facet_counts = §6
    highlight   = highlightField(stored, tokenize(q))              // highlight.ts kept, tokens re-derived
    return Typesense envelope (schema.ts validators kept)
```

**Kept ~verbatim:** `tokenizer.ts`, `score.ts`, `ranking.ts`, `rankProfiles`, `highlight.ts`, the envelope validators in `schema.ts`, `collections.ts`/`configSync.ts`/`diffCollection.ts` (extended with slot mapping), `sortIndex.ts` + `counters.ts` (aggregate usage), `storedFields.ts`.
**Dropped:** `postingChunks.ts`, `docTerms`, `terms.ts`, `filterPostings.ts`, `facetPostings.ts`, `facetCounts` table, `docKeyCounters`, the driver-token AND loop in `textSearch.ts`, fixed-50 `upsertMany` batching. `trigrams`/`fuzzy.ts` demoted to **optional opt-in spell-suggest** (off the hot path).

---

## 6. Behavior contract (what changes, made honest)

| Behavior | Old | New | Surfaced how |
|---|---|---|---|
| Multi-word query | strict AND | native OR → **re-imposed AND app-side** over ≤K | same AND result for the page; `found_approximate: true` if the AND set may exceed K |
| `text_match` score | `exact=3/prefix=2/typo=2−0.5d` | **synthesized from native rank position** | `hit.score` still a number; rank profiles re-tuned (Task: re-tune) |
| `found` (total) | exact via terms / capped 4000 | **exact via aggregate** when filter/facet-expressible; else candidate-bounded | `found_approximate` flag |
| Facet counts | in-memory tally / counters | **aggregate O(log n)** for browse+declared; candidate-window tally for query-scoped | `facets_scoped`/`found_approximate` when over a relevance-biased ≤K window |
| Typo tolerance | tunable 0/1/2 inline | native prefix + **optional** trigram spell-suggest | documented; opt-in |
| Numeric range filter | indexed buckets | native `.eq` + **post-filter/aggregate range** over ≤K | bounded; `found_approximate` if range narrows beyond K |
| Per-collection field count | unbounded (silent trunc.) | **hard cap = slot count**, error at config time | thrown error naming the cap |
| Instant consistency | yes | **yes** (native sync-at-commit, measured) | unchanged |

**Hard rule (replaces silent truncation everywhere):** any path that can exceed a bound returns an **honest flag** (`found_approximate`, or a new `order_incomplete`/`facets_scoped`), never a silently-wrong number.

### 6a. Bounded-reads invariant (NO function may pull the whole collection)

This is a first-class requirement, not an afterthought. **Every query/mutation must read a number of rows that is independent of collection size**, with exactly these allowed sources of "many":

| Concern | Allowed cost | FORBIDDEN |
|---|---|---|
| Search retrieval | `.take(K)`, `K ≤ 1024` | `.collect()` on a search query (native throws past 1024 anyway) |
| `found` / facet totals | `@convex-dev/aggregate` O(log n) node reads | tallying over the matched docs |
| Per-page hits | `≤ perPage` (≤250) | loading the full matched set |
| Browse / sort | aggregate `at`/`atBatch`, `≤ window` (≤1000) | scanning the collection |

**The three bulk operations the spec previously left implicit — now explicit (they MUST stay paged + self-scheduling, never one-shot):**

1. **`deleteCollection`** — must delete `searchDocs` rows (and clear aggregate namespaces) in **bounded batches via `ctx.scheduler.runAfter(0, ...)`**, exactly as the current `collections.ts` already does (`DELETE_BATCH_SIZE` × `DELETE_BATCHES_PER_PUBLIC_CALL`, then self-schedule the remainder). Porting this batched/self-chaining deletion is REQUIRED; a `.collect()`-then-delete is a spec violation. (One simplification vs. today: only `searchDocs` + aggregates to clear, not 8 index tables.)
2. **Reindex / backfill** (the `pendingFields` flow after a config/slot change): the **app replays its own docs through `upsert` in bounded pages** and self-schedules the next page (the existing `example/convex/products.ts` reindex driver pattern, ~100/page). The component never reads the app's full corpus; it processes one `upsert` at a time.
3. **`upsertMany`** — replaces fixed-50 with a batch **bounded by total row-writes, scheduler-chained** if a batch would approach the per-mutation write limit. Since hybrid writes only ~1 `searchDocs` row + a few aggregate ops per doc (vs. ~30–150 before), batches can be larger, but the bound is on *writes*, not a magic doc count.

**Test obligation:** the success criteria (§7) include a test that `deleteCollection` over a collection larger than one batch completes via self-scheduling without exceeding per-call limits, and that no search/read function's read count grows with seeded collection size.

---

## 7. Success criteria

1. **Parity gate:** the existing test suites (`search.test.ts`, `facet-search.test.ts`, `rank-search.test.ts`, `sort-search.test.ts`, `filter*.test.ts`, etc.) are ported and pass — with the **known semantic deltas asserted explicitly** (OR→AND re-verify, synthetic score, flagged approximations), not expected byte-identical.
2. **Scale behavior (measured on a real deployment, not convex-test):** a common-term text query over ≥100k docs returns a page in roughly constant reads (does **not** grow with N, does **not** throw). A faceted/filtered search on a hot value (≥262k docs) succeeds.
3. **Field-cap error:** declaring more search/filter fields than slots throws a clear error at `createCollection`/`sync`.
4. **No hand-rolled index tables remain** in `schema.ts` (postingChunks/docTerms/terms/trigrams[hot]/filterPostings/facetPostings/facetCounts/docKeyCounters gone).
5. **Public API + envelope unchanged** (client `search`/`upsert`/`stats`/… signatures and `searchResultValidator` intact).

---

## 8. Risks & open decisions

- **Slot counts** (Task 1): how many `text*`/`filt*`/`numF*` slots? Trade per-collection field richness vs the ~16-index/table ceiling. **Decision needed before schema is final.**
- **AND-with-common-word recall is a verified REGRESSION vs. today (the one shape where current wins).** A cost model (adversarially verified, 2026-06-21) found: the current design drives a multi-token AND off the **rare** token and verifies the common one in memory, so it is exact and never streams the common term. Native is **OR-by-relevance** — it returns ≤1024 OR-ranked hits, and the app-side AND re-verify can discard most of them, so true all-token matches beyond the top-1024 OR window are **never seen**. Mitigation: query each token's slot and intersect, or query `text0` (all-text) and re-verify with K at max (≤1024), and **flag `found_approximate`**. Acceptable given the <1000-doc request ceiling, but the implementation plan MUST include a test asserting this known delta (not treat it as a bug).
- **Correction to an earlier framing:** the current text path does **not** throw on common terms — it is budget-capped (~63 chunk reads, stops at 4000 entries) and returns *fast but silently approximate* (4000 of ~100k). So hybrid's text win is **honest bounded recall (1024, flagged)** vs. current's **silent truncation (4000, unflagged)** — a correctness/transparency win, not a latency win, on that shape. Hybrid's *decisive* wins are: faceted-count-under-hot-filter (current THROWS — the one genuine crash), hot-value equality/range filters (current silently wrong), and concurrent ingest throughput (docKeyCounter hot row removed).
- **Hot facet-value write contention:** one dominant facet value still contends on one aggregate leaf (no sharded-counter installed). Mitigation: namespace per `[collection, field]` + `maxNodeSize`; accept residual, or add `@convex-dev/sharded-counter` later.
- **`convex-test` cannot validate native-search behavior** — scale/semantic criteria (§7.2) must be checked against a real deployment.

---

## 9. Out of scope (later)

Vector/semantic search (`.vectorIndex`, bounded 1–256 results, action-only) as a complementary subsystem; cross-field BM25 score fusion beyond the max/sum heuristic; array-valued facet/filter fields.
