# Typo-Tolerant Prefix Search — Design

**Date:** 2026-06-13
**Status:** Approved (design); pending implementation plan
**Scope:** Add prefix matching (search-as-you-type), trigram-based typo tolerance (fuzzy), and relevance ranking to the existing exact-AND search.
**Depends on:** Phase 1 (tokenizer, collections/documents/postings, write path, search envelope).
**Relationship to roadmap:** This pulls the *matching core* of the provisional Phase 3 spec forward. After this lands, Phase 3's remaining work is **highlighting** and the **advanced weighted `sort_by`**. Phase 2 (filtering + faceting) is unaffected and still queued.

## Motivation

Phase 1 matches whole tokens only (no prefix, no typo). The example storefront queries on every keystroke, so any incomplete trailing word (`aur`, `aurora sh`) matches no exact term and — because matching is AND — returns 0 hits. Search-as-you-type therefore feels broken even though full-word search is correct. Typesense's default behavior is prefix-on-last-token + typo tolerance; this design brings the component to that parity.

## Decisions (locked)

- **Prefix matching** applies to the **last query token only** (search-as-you-type). Earlier tokens are treated as complete words (exact or fuzzy).
- **Typo tolerance** uses a **trigram candidate index + Levenshtein edit-distance filter** (scalable; no full term-dictionary scan at query time).
- **Typo budget by token length** (Typesense-style): length ≤ 3 → 0 typos; 4–7 → 1; ≥ 8 → 2.
- **Matching stays AND across tokens.** Within a token, candidates from exact ∪ prefix ∪ fuzzy are unioned.
- **Relevance ranking** is introduced and populates `text_match`; results sort by score descending, tie-broken by `docId`.
- Indexing remains **synchronous** (one transaction per write).

## Data Model Additions

Two new tables, both owned by the component and maintained in the write path.

```
terms
  collection: string
  term: string
  docCount: number          // how many documents in the collection contain this term
  // index: by_collection_term [collection, term]   (exact point lookup, prefix range scan, dedupe)

trigrams
  collection: string
  gram: string              // a 3-char gram of `term` (or the whole term if length < 3)
  term: string
  // index: by_collection_gram [collection, gram]    (fuzzy candidate generation)
```

- `terms` is the distinct-term dictionary per collection. `docCount` is a reference count used to know when a term (and its trigram rows) should be created or removed.
- `trigrams` rows are tied to **term existence**, not per-document: exactly one row per `(collection, gram, term)`, created when a term first appears in the collection (`docCount` 0→1) and removed when it disappears (`docCount` →0). This keeps the trigram index size proportional to distinct terms, not documents.

`postings` (Phase 1) is unchanged and still maps `term → docIds` for resolving matched terms to documents.

## Tokenizer Addition

A pure `trigrams(term: string): string[]` function lives alongside `tokenize`:

- term length ≥ 3 → all contiguous length-3 substrings, de-duplicated (e.g. `"shoe"` → `["sho", "hoe"]`).
- term length 1–2 → `[term]` (the whole short term as a single gram).
- empty → `[]`.

Shared by write-path indexing and query-time fuzzy candidate generation so they cannot disagree.

## Write Path Changes (synchronous, replace-semantics preserved)

`upsert` already deletes a doc's prior `postings` then writes new ones. Extend it to maintain `terms` + `trigrams` via a **distinct-term diff**:

1. Compute `oldTerms` = the doc's distinct terms before this write (derive from the existing `postings` rows for `(collection, docId)` that upsert already loads to delete).
2. Compute `newTerms` = distinct terms across the doc's `searchFields` after tokenization.
3. For each term in `newTerms \ oldTerms` (added): increment `docCount`; if the `terms` row did not exist, create it (`docCount = 1`) and insert its `trigrams` rows.
4. For each term in `oldTerms \ newTerms` (removed): decrement `docCount`; if it reaches 0, delete the `terms` row and its `trigrams` rows.
5. Terms in both sets: no change.

`delete(collection, id)` is the special case where `newTerms = ∅`: decrement `docCount` for all of the doc's old terms, removing term + trigram rows that reach 0.

All in the same transaction as the postings/document writes.

## Query Pipeline (search)

New optional arg considerations: behavior is automatic; no new required args. (Internally the handler knows which token is last.)

For query `q` → `tokens = tokenize(q)`. Empty → match-all (unchanged). Otherwise, for each token at index `i` (last index = `tokens.length - 1`):

1. **Exact:** point lookup in `terms` for the token → if present, candidate term with quality `EXACT`.
2. **Prefix (last token only):** range scan `terms` on `by_collection_term` from `>= token` to `< token + "￿"` → each as candidate with quality `PREFIX` (unless already EXACT).
3. **Fuzzy:** budget `B = byLength(token.length)`. If `B > 0`:
   - generate token trigrams; for each, read `trigrams` by `[collection, gram]` and tally per-term overlap counts.
   - keep candidate terms whose overlap ≥ `max(1, tokenTrigramCount - B*3)` (an edit changes at most 3 trigrams), then confirm with `Levenshtein(token, term) <= B` (DP with early cutoff). Quality `TYPO(distance)` (unless already EXACT/PREFIX for that term).
4. Resolve each token's candidate terms to docIds via `postings` (filtered to `queryBy` fields if provided); **union** within the token. A token with no candidate terms ⇒ empty set ⇒ (under AND) zero results.
5. **AND-intersect** the per-token docId sets → match set; `found` = its size.
6. **Score** each matched doc: for each token take the best quality among that token's matched terms the doc actually contains (`EXACT=3`, `PREFIX=2`, `TYPO` → `2 - 0.5*distance`); sum across tokens → `text_match`.
7. Sort by `text_match` desc, tie-break by `docId`; paginate; assemble hits (now with real `text_match`).

`highlight` stays `{}` and `facet_counts` stays `[]` (later phases). Envelope shape is unchanged.

## Error Handling

- Unchanged collection validation (`CollectionNotFound`), `perPage`/`page` clamping.
- Short tokens (≤ 3 chars) get 0 typo budget, so they rely on exact/prefix only — avoids fuzzy noise on tiny tokens.

## Known Limits

- Fuzzy quality depends on trigram overlap + Levenshtein thresholds; these approximate Typesense's typo model and may be tuned against the sample data.
- Still bounded-scale at query time for very high-frequency terms (the Phase 1 hot-term postings ceiling is unchanged; that remains the scale-hardening phase's problem).
- Write amplification increases (terms + trigram rows maintained per write); acceptable for current scale, revisited in scale hardening.

## Testing Strategy (TDD — colocated `*.test.ts`, convex-test + Vitest)

- **`trigrams()` unit:** length ≥3 windows + dedupe; 1–2 char whole-term; empty.
- **Levenshtein/budget unit** (if extracted as a pure helper): distances, early cutoff, byLength budget mapping.
- **Write-path maintenance:** upsert creates `terms` (docCount=1) + trigram rows; second doc sharing a term bumps docCount to 2 without duplicate trigram rows; re-upsert that drops a term decrements/removes; delete removes term+trigrams when docCount hits 0; multi-collection isolation of terms/trigrams.
- **Search — prefix:** `aur` → matches `aurora*` (last-token prefix); a non-final partial token does NOT prefix-match.
- **Search — fuzzy:** `fone`→`phone`, `aurara`→`aurora`; budget respected (a 2-edit miss on a 5-char token returns nothing); short token (`re`) does not fuzzy-explode.
- **Search — ranking:** exact outranks prefix outranks typo; `text_match` is populated and ordering is deterministic.
- **Search — AND across mixed match types:** `red shoo` (typo) still ANDs.
- **Example app:** search-as-you-type now returns results for partial words; verify `aur`→2, `aurra`→ Aurora hits.
