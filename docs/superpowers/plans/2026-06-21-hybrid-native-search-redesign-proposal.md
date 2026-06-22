# Proposal: Hybrid Native-Search Redesign for Million-Scale FuzzySearch

**Status:** Proposal (decision document) — pending approval before a task-by-task implementation plan is written.
**Date:** 2026-06-21
**Author:** Architecture review (60-agent scalability audit + 4-architecture design bake-off, adversarially scored)
**Context:** Component is **pre-deployment** — no production data, no migration burden. Refactor vs. rebuild is a free choice.

---

## 1. Problem statement

The current `FuzzySearch` component is a hand-rolled Typesense-style inverted index where every index is a plain Convex table (`postingChunks`, `docTerms`, `terms`, `trigrams`, `filterPostings`, `facetPostings`, `facetCounts`, plus aggregates for count/sort). A 60-agent review verified **39 scalability defects**. They reduce to one structural fact:

> **A table-backed inverted index pays one row-read per posting by construction.** It is *asymptotically read-amplifying*. No amount of tuning changes the asymptote.

Concrete walls (all verified against Convex's documented limits and the installed packages):

| Failure | Verified math | Symptom |
|---|---|---|
| Hot value/term read wall | `4096 reads × 64 docs/chunk = 262,144` | A term/filter/facet value shared by **≥262K docs** makes a query **throw** "too many reads" |
| Hot-term chunk reads at 1M docs | `1,000,000 / 64 = 15,625` chunk reads | Far over the 4,096-read wall — fails well before 1M |
| Hot-row write OCC | per-collection `docKeyCounter`, per-value facet counter, per-term `docCount`, tail buckets | Concurrent ingest **serializes** to ~one writer |
| Silent wrong results | live `sortBy` ranks 200 docs; candidate budget truncates lexicographically; facet `take(200)` before count-sort; `found` capped at 4000 reported as exact | Wrong order / wrong counts / wrong totals, **no flag** |

**Target (confirmed by user): millions+ docs per collection (1M–50M) is a hard requirement.** That single fact eliminates "just fix the bugs" — hardening the hand-rolled index tops out at ~200K–500K docs/collection regardless of effort (it scored **3/10 on scale** in the bake-off).

---

## 2. Recommended technique

### Hybrid: Convex managed `.searchIndex` for retrieval + `@convex-dev/aggregate` for counts/sort + ported ranking DSL as an in-memory re-rank

Delete the hand-rolled inverted index. Let Convex's **managed full-text search index** own text retrieval (it is a managed segment index — a text query touches an index structure, **not N posting rows**, so a term matched by millions of docs returns its top-K with **zero posting reads**). Keep everything native cannot do as thin layers on top.

```
            ┌─────────────────────── KEPT / PORTED (≈1,366 LOC, 65%) ───────────────────────┐
  query ──► tokenizer ──► native .searchIndex (managed retrieval) ──► app-side AND re-verify
                                                                          │
                                              ranking DSL (score.ts / ranking.ts / rankProfiles)
                                                  in-memory re-rank over top-K candidates
                                                                          │
            facet counts + sort + out_of  ◄── @convex-dev/aggregate (O(log n), namespaced)
                                                                          │
                                              highlight.ts + Typesense envelope (schema.ts)
            └──────────────────────────────────────────────────────────────────────────────┘

            ┌──────────────── DROPPED (≈739 LOC of read-amplifying internals) ───────────────┐
            postingChunks · docTerms · terms · trigrams(hot path) · filterPostings ·
            facetPostings · facetCounts · docKeyCounters · driver-token AND loop
            └──────────────────────────────────────────────────────────────────────────────┘
```

**This is a layer swap, not a new project:** ~739 LOC deleted, ~1,366 LOC kept/ported. The **public API and result envelope are unchanged** — only the storage backing changes.

### Why this technique (vs. the three alternatives that were scored)

| Option | Scale | Features | Effort | Total /50 | Why not |
|---|---|---|---|---|---|
| Native-first | 8 | 3 | L | 25 | Throws away the ranking DSL (the differentiator); multi-tenant↔static-schema mismatch unaddressed |
| **Hybrid (recommended)** | **7** | **5** | **L** | **29** | — |
| Harden hand-rolled | 3 | 10 | M | 29 | **3/10 scale — fails the hard millions requirement.** Keeps every feature but never reaches the target |
| Segment/LSM | 6 | 9 | XL | 20 | XL effort; "O(segment count)" read claim is false (8192-array cap forces multi-row hot terms — the wall just moves and returns); native gets there at a fraction of the complexity |

Hybrid is the only option that **reaches millions (deletes the read-amplifying structure rather than bounding it)** *and* **preserves the ranking DSL** (ported verbatim as a post-fetch re-rank). It scored highest, tied with hardening — but hardening is disqualified by the scale target.

---

## 2b. Verified against installed Convex 1.41 source (not docs)

Inspected `node_modules/convex/dist/esm-types/server/{search_filter_builder,query,schema,vector_search}.d.ts`:

**Confirmed (load-bearing for this design):**
- **`withSearchIndex(...)` returns an `OrderedQuery`** — the *same* interface as a normal indexed read (`query.d.ts:69`). So after a search we can chain **`.filter()`, `.take(n)`, `.collect()`, `.first()`, and `.paginate()`**, and iterate with `for await`. This is what makes app-side AND re-verification and bounded top-K fetch viable. **Verified.**
- **Search returns plain documents with NO score** — the consumer yields `DocumentByInfo<TableInfo>`, no `_score` wrapper. Confirms the "synthesize score from rank position" requirement. **Verified.**
- **OR-by-relevance** — `search_filter_builder.d.ts` verbatim: *"a full text search that returns results where any word of `query` appears in the field."* **Verified.**
- **`filterFields` are `.eq()`-only** — the `SearchFilterFinalizer` exposes **only `.eq()`**, no range ops (`search_filter_builder.d.ts`). Range filtering must use post-`.filter()` over candidates or an aggregate range scan. **Verified.**
- **One `searchField` per index** — `SearchIndexConfig.searchField` is a single string field; `filterFields` is an array (`schema.d.ts:61-72`). Confirms the generic-slot mapping is required for multi-field/multi-tenant. **Verified.**

**New facts that *strengthen* the design (not in the original proposal):**
- **Staged search indexes exist** (`schema.d.ts:225-243`): `searchIndex(name, { ..., staged: true })` lets you push the index without blocking deploy and enable it later — *"For large tables, index backfill can be slow."* This is a **clean backfill story** for the generic-slot table: stage the index pool, populate, then enable. Removes a migration risk the original proposal didn't account for.
- **Vector search is concretely bounded** (`vector_search.d.ts`): `limit` is **1–256** (default 10), returns `{ _id, _score }[]` (vector search *does* expose `_score`, unlike text search), filter supports **`q.or` + `q.eq`**. So the optional semantic-search Phase 6 has firm, known limits. **Verified.**
- **The `OrderedQuery` doc explicitly warns against `.collect()`** on unbounded search results (`query.d.ts:106-109`) — reinforces using `.take(K)`/`.paginate()` for the top-K window.

**Still NOT verifiable from source (must probe — see §5):** the exact **top-K result cap** (docs say ~1024; not encoded in types) and **whether `.searchIndex` is searchable synchronously at mutation-commit or has indexing lag**. The staged-index language (*"backfill can be slow"*) hints indexing is **asynchronous**, which makes the Phase-0 lag probe even more important.

---

## 2c. PHASE-0 PROBE RESULTS — measured on the live dev deployment (2026-06-21)

Ran a throwaway probe (`example/convex/searchProbe.ts` + a `searchProbe` table with a real `.searchIndex`) against the configured Convex 1.41 deployment. **All gating assumptions resolved; results below are observed, not inferred.** Probe + table removed after the run (3,005 rows cleaned up).

| Question | Result | Evidence |
|---|---|---|
| **Synchronous at commit?** (the gate) | **YES — synchronous.** A doc inserted in a mutation is searchable by `withSearchIndex` **in the same transaction**. | `probeSameTxn` → `foundInSameTxn: 1`. Also `seedToken`→`probeFind` after commit → `found: 1`. **No indexing lag observed.** |
| OR vs AND semantics | **OR-by-relevance**, confirmed live. Searching `"alphaprobe betaprobe"` returned all **3** docs (both / alpha-only / beta-only). | `probeOrSemantics` → `hitCount: 3` |
| Result cap | **Hard 1024, and it THROWS — does not silently truncate.** `.take(1024)` returns exactly 1024; `.take(2000)` and `.collect()` over a >1024 match set both error. | Server error verbatim: *"Search query scanned too many documents (fetched 1024). Consider using a smaller limit, paginating the query, or using a filter field..."* |
| Score field on text hits | **NO `_score`.** Hit keys are exactly `_id, _creationTime, title, category, n`. | `probeCap` → `hasScoreField: false` |
| API chain type-checks | `withSearchIndex(...).eq(...).take(n)` and the `.searchIndex(...)` schema def compile cleanly. | `tsc -p example/convex --noEmit` → exit 0 |

**Impact on the recommendation — it gets *stronger*:**
- The one disqualifying risk (async indexing lag → losing instant searchability) **did not materialize**: native search is synchronous-at-commit, so the hybrid design **preserves instant in-transaction searchability**. The Phase-0 gate is **PASSED**.
- The 1024 cap **throwing** (not truncating) is actually *helpful*: it means we cannot accidentally ship silent truncation — we must page or narrow with a filter field, which forces honest behavior by construction. Design implication: always `.take(K)` with `K ≤ 1024`, lean on `filterFields` (`.eq`) to shrink the scanned set, and use `.paginate()` for deep reads.
- OR-semantics and no-score are confirmed costs (re-impose AND app-side; synthesize the score) — exactly as §3 states. No surprises.

---

## 3. The honest cost (three verified constraints, not opinions)

These are the price of native retrieval. All three were verified against installed code, not docs.

1. **Native is OR, not AND.** Convex's own type definition states a search *"returns results where any word of the query appears"* (verified in `node_modules/convex/dist/.../search_filter_builder.d.ts`). The current engine does strict AND. **Mitigation:** re-tokenize the query and re-verify candidates app-side. **Residual risk:** if native's top-1024-by-BM25 doesn't contain enough true-AND matches, a selective multi-token query can under-fill a page (recall dip). Flag `found_approximate` when the AND-filtered set may exceed the window.

2. **Native exposes rank order, not a score.** There is no `_score` field. The ranking DSL consumes a numeric `textMatch` (`rawScore` in `search.ts:330/335`). **Mitigation:** synthesize the score from rank position (e.g. `1/(rank+1)`), isolated behind one function so the DSL is untouched. **Residual cost:** the `exact=3 / prefix=2 / typo=2−0.5d` scale disappears; existing `rankProfiles` need re-tuning against the synthetic scale.

3. **Native fuzzy is being deprecated, and relevance/per-field weights can't decide candidate *entry*.** Per-field weights (`title^3` vs `body^1`) only re-order the K native already selected by un-tunable BM25. **Mitigation:** keep `trigrams` as an **opt-in, off-hot-path spell-suggest** for deployments needing distance-2 typo recall; document that weights re-rank but don't re-select.

Plus one structural bridge: **multi-tenant runtime fields ↔ static native schema.** Collections are runtime rows; `.searchIndex` columns are deploy-time and capped (~16/table). The bridge is a **generic-slot schema** (`text1..textN`, `textAll`, `filterStr1..M` / `filterNum1..M`) with a mapping layer extending `configSync.ts`. **Cost:** a hard cap of ~a dozen searchable/filterable fields per collection — enforced with a clear error (which *replaces* today's silent truncation, a net correctness win).

---

## 4. Estimated % improvements

Baselines are from the verified review. "Improvement" is stated against the **current hand-rolled design at the relevant scale**. Ranges reflect data-shape dependence (facet cardinality, query selectivity).

### Scale ceiling
| Metric | Current | Hybrid | Improvement |
|---|---|---|---|
| Max docs/collection before hot-value query throws | ~262K | ~tens of millions (managed index, no read-amp) | **~40–100×** (≈ +3,900–9,900%) |
| Hot-term read cost at 1M docs | 15,625 chunk reads (fails) | O(1) managed-index lookup | **>99% fewer reads** on the text path |

### Read path (per query, at 1M docs)
| Query shape | Current | Hybrid | Improvement |
|---|---|---|---|
| Text search on a common term | throws / approximate | bounded top-K, succeeds | **fails → works** (qualitative) |
| Faceted search on a hot value (≥262K) | throws | aggregate O(log n) counts | **fails → works** |
| Numeric range on low-variance field | throws | native filter / aggregate range | **fails → works** |
| Deep browse pagination | already aggregate-backed | unchanged | ~0% (already good) |
| Selective text query (few matches) | ~hundreds of reads | ~tens of reads | **~50–70% fewer reads** |

### Write / ingest path
| Metric | Current | Hybrid | Improvement |
|---|---|---|---|
| Doc-writes per upsert (large text doc) | N posting chunks + docTerms array + terms + trigrams (can blow 8192-write / 8192-array) | 1 documents row + aggregate ops per facet/sort field | **~70–90% fewer row writes**; the 8192-array failure is **structurally eliminated** |
| Concurrent ingest throughput | serialized by `docKeyCounter` + hot counters (≈1 effective writer) | key on `docId` (no monotonic counter); contention only on a single dominant facet value | **~5–20×** with well-distributed facet values (less if one value dominates) |
| `upsertMany` failure mode | fixed-50, can fail whole batch atomically | scheduler-chained, sized by row-write count | **fails → degrades gracefully** |

### Correctness (silent → honest)
| Issue | Current | Hybrid |
|---|---|---|
| Live `sortBy` on undeclared field | silently ranks 200 docs | clear error or `order_incomplete` flag |
| Facet counts at high cardinality | silently wrong (`take(200)` pre-sort) | aggregate-exact, or flagged candidate-scoped |
| `found` over 4000 matches | reported as exact | aggregate-exact, or `found_approximate` |
| Candidate term truncation | lexicographic, silent | native relevance order, flagged |

**Headline number:** the change converts the component from **"throws or silently lies above ~262K docs"** to **"correct and bounded into tens of millions," at the cost of OR-semantics + a synthesized relevance scale on the text path.** Code-wise it is a **~65%-kept layer swap** (≈739 LOC deleted, ≈1,366 LOC ported), effort **L**.

> **Estimate confidence:** Scale-ceiling and read-amplification numbers are **high confidence** (arithmetic against documented limits). Ingest-throughput and selective-query numbers are **medium confidence** (depend on facet-value distribution and aggregate B-tree contention, which has no sharded-counter mode installed — see §6). One assumption is **unverified** and gates the whole proposal — see §5.

---

## 5. Blocking pre-work (½–1 day, before any schema is written)

**Phase 0 probe on Convex 1.41 — verify empirically, do not trust docs:**
1. **Is `.searchIndex` queryable synchronously the instant a mutation commits, or is there indexing lag?** Today's hand-rolled tables give instant in-transaction searchability; if native lags, that's a real (likely acceptable) regression that must be documented, and it may push some flows to read-after-write differently.
2. Confirm OR semantics, the ~1024 top-K cap, and that no numeric score is returned.
3. Confirm `filterFields` are equality-only and behavior of `.filter()` post-search at scale.

If (1) reveals unacceptable lag, the recommendation weakens and we revisit a tiered design (hand-rolled fast path for small collections, native for large) — so this probe is genuinely decision-gating.

---

## 6. Open risks / decisions for the user

- **A vs B ranking depth** (you were undecided): **A** = field-boosts only (drop the DSL); **B** = keep the full DSL as a re-rank over top-K. Recommendation: **B** — the DSL code is *kept verbatim*, so B is barely more effort and preserves the differentiator. The only loss is that weights re-order but don't re-select candidates.
- **Aggregate contention has no free fix.** `@convex-dev/sharded-counter` is **not installed** and `@convex-dev/aggregate@0.2.1` has **no sharded-counter mode** (verified). A single dominant facet value (`status:"active"`) still contends on one B-tree leaf. Decision: accept it (mitigate with namespacing + `maxNodeSize`), or add the sharded-counter component.
- **Per-collection field cap** (~a dozen) from generic slots — acceptable for typical tenants (≤4 search fields, a handful of filters)? Confirm against expected tenant shapes.

---

## 7. What happens next

If approved, the deliverable is a **task-by-task TDD implementation plan** (writing-plans format) covering:
- Phase 0 probe → Phase 1 generic-slot schema + mapping layer → Phase 2 retrieval w/ app-side AND → Phase 3 DSL re-rank + envelope + highlight derivation → Phase 4 aggregate counts/sort + scheduler-chained ingest → Phase 5 honest truncation flags + port the existing test suite as a parity gate (asserting the *known* semantic changes, not byte-identical output) → Phase 6 optional trigram spell-suggest + vector search.

**Salvaged verbatim or near-verbatim:** `tokenizer.ts`, `score.ts`, `ranking.ts`, `rankProfiles`, `highlight.ts` (matched-tokens re-derived from query), the result envelope (`schema.ts` validators), `collections.ts`/`configSync.ts`/`diffCollection.ts` (become the slot-mapping source), `sortIndex.ts` + `counters.ts` aggregate usage, `storedFields.ts`.
**Dropped:** `postingChunks.ts`, `docTerms`, `terms.ts`, `filterPostings.ts`, `facetPostings.ts`, `facetCounts.ts` table, `docKeyCounters`, the driver-token AND loop in `textSearch.ts`, fixed-50 `upsertMany` batching; `trigrams` demoted to opt-in.
