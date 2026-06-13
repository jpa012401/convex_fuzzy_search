# Typesense-style Search Convex Component — Phase 3 Design

**Date:** 2026-06-13
**Status:** PROVISIONAL roadmap spec — to be re-reviewed/refined when Phase 2 is complete
**Scope:** Phase 3 — Typo tolerance + weighted relevance ranking + highlighting
**Depends on:** Phases 1–2

## Goal

Bring search quality to Typesense parity: fuzzy matching (typo tolerance),
a real `text_match` relevance score with per-field weighting (the
Elasticsearch-style weighted sort the project targets), and result
highlighting. The Typesense envelope's `text_match` and `highlight` fields —
placeholders since Phase 1 — get populated here.

## 1. Typo Tolerance (fuzzy matching)

**Approach:** trigram candidate generation + edit-distance filter.

Data model additions:
```
terms
  collection: string
  term: string
  df: number            // document frequency (for IDF ranking)
  // index: by_collection_term [collection, term]

trigrams
  collection: string
  trigram: string       // 3-char gram of a term (padded)
  term: string
  // index: by_collection_trigram [collection, trigram]
```
`terms`/`trigrams` are maintained in the write path (synchronous), keyed off the
postings already produced in Phase 1.

**Query expansion:** for each query token →
1. generate its trigrams → look up candidate terms sharing ≥ threshold trigrams,
2. filter candidates by Levenshtein edit distance using Typesense-style rules
   (default: up to 2 typos, fewer for short terms; configurable `num_typos`),
3. expand the token to `{exactTerm, ...fuzzyTerms}` and union their postings.

Exact matches score higher than fuzzy (see ranking).

## 2. Weighted Relevance Ranking (`text_match`)

Per matched doc, compute a relevance score combining:
- **Field weights** — `query_by_weights` per searched field (e.g. name=4,
  brand=2, description=1). Uses the `field`/`tf` columns stored since Phase 1.
- **Term frequency / IDF** — `tf` from postings, `df` from `terms`.
- **Tokens matched** — more query tokens matched ⇒ higher.
- **Typo penalty** — exact term match outranks a fuzzy match.
- **Optional proximity** — adjacency bonus (may defer if costly).

Also support **`sort_by`** with a weighted formula blending relevance with a
numeric field, e.g. `sort_by: "_text_match:desc, popularity:desc"` or a weighted
combination `score = w1*text_match + w2*normalize(popularity)` — this is the
Elasticsearch-style weighted sort feature. Default sort = `text_match` desc.

Results are sorted by score; `hits[].text_match` carries the score.

## 3. Highlighting

For each hit, mark matched (and fuzzy-matched) query tokens within the stored
searchable fields → populate `highlight`:
```jsonc
"highlight": {
  "name": { "snippet": "Apple <mark>iphone</mark> 15", "matched_tokens": ["iphone"] }
}
```
Computed from `documents.stored` field text + the expanded query tokens
(snippet window configurable).

## Known Limits (Phase 3)

- Ranking/typo still operate on the bounded candidate set; arbitrary-scale
  early-termination and capped candidates are Phase 4.
- Trigram + edit-distance is an approximation of Typesense's exact typo model;
  tune thresholds against the sample data.

## Open Questions (resolve at phase start)

- Levenshtein thresholds vs. term length — match Typesense defaults exactly or
  pick simpler rules?
- Include proximity/phrase bonus in v1 of this phase or defer?
- `sort_by` formula grammar — fixed set of forms vs. a small expression parser.

## Testing Strategy (TDD)

- Trigram generation + candidate lookup; edit-distance filter correctness.
- Typo queries ("fone"→"phone") return expected hits; exact outranks fuzzy.
- Ranking: field-weight ordering; tokens-matched ordering; `sort_by` weighted
  blends; deterministic tie-breaks.
- Highlighting: correct marks, snippet windows, fuzzy-matched tokens.
- Sample app: enable the sort control + relevance ordering + highlighted hits.
