# Phase 4 · S5 — Hot-Term Postings Bounding — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Scope:** Bound the per-query postings reads in the text-search path so a very common term (or short prefix) can no longer load unbounded rows. Driver-token intersection (exact) for the common case; a budget cap + `found_approximate` flag for the pathological residue.
**Part of:** Phase 4 indexed-retrieval program (S5 of S1→S5 — the final slice). Depends on the `terms` table (per-term `docCount`, already maintained) and postings indexes.

## Problem

The text path in `search.ts` calls `docScoresForToken` once per query token, which `.collect()`s **all** postings for **every** candidate term of that token (`postings` by `by_collection_term`). A single very common term — or a short prefix expanding to many large postings lists — loads an unbounded number of rows, exceeding Convex's ~4096-reads-per-query limit and slowing every query that contains a common word. This is the only remaining unbounded read path after S1–S4.

Key existing asset: the `terms` table already stores `docCount` per (collection, term) — the document frequency — so term selectivity is known **without** reading postings.

## Decision

Two complementary mechanisms:

### 1. Driver-token intersection (exact; bounds the common case)

Instead of collecting every token's full postings and intersecting, drive the intersection from the **most selective** token:

1. For each query token, compute its candidate terms (exact ∪ prefix ∪ fuzzy, as today) **with each candidate's `docCount`**. The token's selectivity estimate is the sum of its candidates' `docCount`.
2. Choose the token with the smallest selectivity estimate as the **driver**.
3. Collect postings only for the **driver** token's candidate terms → a `docId → score` map (best candidate score per doc), honoring `queryBy` (skip postings whose `field` is excluded).
4. For each **non-driver** token, verify membership per driver doc: read that doc's postings via `by_collection_doc` (`eq(collection).eq(docId)`), intersect the doc's terms with the token's candidate terms (honoring `queryBy`), and take the best matching candidate score. A driver doc that fails any non-driver token is dropped (AND semantics).
5. The surviving docs' scores are the sum of per-token best scores — **identical** to the current scoring, so results match pre-S5 exactly.

Reads now scale with the **driver (≈ result) size** × number of tokens, not with the corpus frequency of the common words. "waterproof jacket" no longer reads all of "jacket".

### 2. Budget cap + `found_approximate` (bounds the pathological residue)

Collecting the **driver's** postings (step 3) is capped at `POSTINGS_BUDGET = 4000` rows. If the driver itself has more postings than the budget (a single ultra-common term, or a 2-char prefix whose smallest token is still huge), collection stops at the budget, the matched set is the bounded prefix of what was read, and a `truncated` flag is set.

- **`found_approximate`:** a new boolean on the result, `true` exactly when the driver scan was truncated.
- **`found` when truncated:** if the query is a **single exact term** (one token, no prefix/fuzzy expansion — i.e. its candidate set is exactly `{token}` with score EXACT), `found` is the exact `terms.docCount` for that term (the true match count, even though only a bounded page of hits is returned). Otherwise `found` is the size of the bounded matched set (a lower bound), with `found_approximate: true`.
- When **not** truncated, `found` is exact (the matched-set size) and `found_approximate` is `false`.

`POSTINGS_BUDGET` is a module constant (4000 — headroom under the 4096 read limit). Not configurable in this slice (YAGNI).

## Data flow / module structure

- **`matching.ts`** — `candidateTermsForToken` returns `Map<string, { score: number; docCount: number }>` instead of `Map<string, number>`. Exact and prefix branches already read the `terms` rows (which carry `docCount`); the fuzzy branch adds a bounded `docCount` lookup per surviving fuzzy candidate (fuzzy candidates are already bounded by the trigram-overlap threshold). All existing scoring/threshold logic is unchanged.
- **New `textSearch.ts`** — `matchTokens(ctx, collection, tokens, queryBy, budget = POSTINGS_BUDGET)` returns `{ scoreById: Map<string, number>; matchedTerms: Set<string>; truncated: boolean; singleExactTerm: string | null }`. It implements the driver selection, budget-capped driver collection, non-driver membership verification, and scoring. `singleExactTerm` is the term when the query is one exact-only token (enables the exact `found` from `docCount`), else `null`. The `budget` parameter is an internal seam (defaulting to the `POSTINGS_BUDGET` constant) so truncation is unit-testable without seeding thousands of docs; it is **not** exposed on the public `search` API.
- **`search.ts`** — the text path replaces the inline `docScoresForToken` + `perToken` sort/intersect with a single `matchTokens(...)` call; threads `truncated` → `found_approximate`, and computes `found` per the rule above (using `terms.docCount` when `singleExactTerm` is set and truncated). `loadDocs`, faceting, ranking/sort, pagination, hydration over the matched set are unchanged. `docScoresForToken` is removed (subsumed by `textSearch.ts`).
- **`types.ts`** — add `found_approximate: boolean` to `SearchResult` (always present).
- **All other return points** in `search.ts` (lean browse, lean browse+facets, lean browse+sort, browse+filter, full-load) set `found_approximate: false`.
- **Client** — `SearchResult` is re-exported, so `found_approximate` flows through with no client change.
- **Example** — surface `found_approximate` in the storefront with a small "≈" hint next to the result count.

## Error handling

- A token with no candidate terms → selectivity 0 → it becomes the driver → empty driver set → empty result (`found 0`), matching today's AND-with-a-no-match-token behavior.
- `queryBy` is honored in both the driver collection and the non-driver membership checks (a posting whose `field` is excluded does not contribute).
- Truncation never throws; it sets the flag. Non-text paths never truncate.

## Known limits after S5

- **Candidate-term enumeration for a very short prefix** scans distinct vocabulary (the `terms` prefix range in `candidateTermsForToken`), bounded by vocabulary size, not postings. This is a smaller, separate residual — documented, not addressed here.
- When the driver is truncated, pagination beyond the bounded set is not meaningful (only the first ≤ budget docs are returnable); this is the accepted meaning of `found_approximate`.
- `POSTINGS_BUDGET` is fixed (not per-query configurable).
- Sharding of a single term's postings is intentionally **not** implemented — driver-intersection + budget cap achieves the same bound the original Phase 4 sketch attributed to sharding.

## Testing strategy (TDD)

- **`matching.ts`:** `candidateTermsForToken` returns the correct `docCount` alongside score for exact, prefix, and fuzzy candidates (update `matching.test.ts`).
- **`textSearch.ts` / search integration:**
  - Multi-term AND result (ids, scores, order) is **identical** to pre-S5 for a normal fixture (golden), via the driver path.
  - The driver is the selective token: a query with one rare + one common term returns correct results without reading the common term's full postings (assert correctness; the bound is structural).
  - `queryBy` restricts matches in both driver and membership paths.
  - Single-token and empty-candidate-token cases correct.
  - **Truncation (at the `matchTokens` unit level, injecting a small `budget`):** with the budget exceeded, `truncated` is `true`; for a single exact-only token, `singleExactTerm` is set; the bounded `scoreById` size ≤ budget.
  - **Search-level `found` semantics:** with `singleExactTerm` set and truncated, `found === terms.docCount` (exact) and `found_approximate: true`; not-truncated text queries report `found_approximate: false` with exact `found`.
  - All non-text paths return `found_approximate: false`.
- Full existing suite stays green (text results unchanged for every non-pathological case).
