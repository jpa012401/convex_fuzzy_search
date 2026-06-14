# Highlighting + Weighted Sort — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Scope:** Result highlighting + weighted/relevance sorting — the remaining Phase 3 functional features.
**Depends on:** Phase 1, typo/prefix search, Phase 2 (search loads all collection docs per query; candidate-term matching + `text_match` ranking + facet/filter all in place).
**After this:** only Phase 4 (arbitrary-scale hardening) remains.

## Decisions (locked)

- **Highlighting:** full-field-value — each matched search field returns its complete text with matched tokens wrapped in `<mark>…</mark>`, plus a `matched_tokens` list. Windowed snippets are a later refinement.
- **Sorting:** BOTH a weighted blend (`rankBy`, Elasticsearch field_value_factor style) AND multi-key ordering (`sortBy`, Typesense style), composable.
- Sort/rank/highlight all operate **in-memory over the stored docs search already loads** — no new tables, no write-path change.
- **Reported `text_match` stays the raw relevance score** (exact/prefix/typo sum). `rankBy`/`sortBy` affect ordering only.

## Highlighting

### Output
Per hit, `highlight` is an object keyed by search field, including only fields that (a) are persisted in the stored doc as a string and (b) contain at least one matched token:
```jsonc
"highlight": {
  "name": { "snippet": "Red <mark>Running</mark> Shoe", "matched_tokens": ["Running"] }
}
```
- `snippet`: the field's original string with each matched word wrapped in `<mark>…</mark>` (original case/punctuation preserved).
- `matched_tokens`: the original surface forms of the matched words, in first-seen order, de-duplicated.
- Empty/whitespace `q` (browse mode) → `highlight: {}` for every hit (no matched terms).

### Mechanism
Search computes, per query token, a candidate-term map (exact ∪ prefix ∪ fuzzy) — see `matching.ts`. Union the keys across all tokens into a `matchedTerms: Set<string>` (normalized document terms; already includes prefix/typo-resolved terms). A pure helper highlights one field value:

`highlightField(value: string, matchedTerms: Set<string>): { snippet, matched_tokens } | null`
- Scan `value` into alternating word / non-word segments (same Unicode alnum split as the tokenizer, but **preserving** the original segments and separators).
- A word segment matches if its lowercased form is in `matchedTerms`.
- Build `snippet` by concatenating segments, wrapping matched words in `<mark>` and `</mark>`.
- Collect `matched_tokens` (original forms, deduped, first-seen order).
- Return `null` if no word matched (caller omits the field).

Only `searchFields` are highlighted (optionally restricted to `queryBy` when provided). A field absent from `stored` or not a string is skipped.

## Sorting

### `rankBy` — weighted blend (optional)
```
rankBy?: { text?: number; fields?: { field: string; weight: number }[] }
```
Defines the **ordering relevance score** for a doc:
```
score = (text ?? 1) * text_match + Σ weightᵢ * Number(stored[fieldᵢ] || 0)
```
- `text_match` is the doc's raw relevance (0 in browse mode).
- Non-numeric / missing field values coerce to `0` (`Number(x)` NaN → 0).
- If `rankBy` is absent, the ordering relevance score === `text_match`.

### `sortBy` — multi-key (optional)
```
sortBy?: { field: string; order: "asc" | "desc" }[]
```
- `field` is either the literal `"_text_match"` or any stored field name.
- For `"_text_match"`, the comparison value is the ordering relevance score (the `rankBy` blend if present, else raw `text_match`).
- For any other field, the comparison value is `Number(stored[field] || 0)`.
- Keys applied lexicographically: first key primary, subsequent keys break ties.

### Composition + default
- Build per-doc ordering score `s(doc)` = `rankBy` blend if present, else `text_match`.
- If `sortBy` present: sort by its keys in order (a `_text_match` key uses `s(doc)`; field keys use the coerced numeric value; `asc`/`desc` per key).
- If `sortBy` absent: sort by `s(doc)` descending.
- **Final tie-break always `docId` ascending** (deterministic, stable output).
- Browse mode (empty `q`): `text_match` is 0 for all, so `rankBy`/`sortBy` still order by their field terms; with neither, falls back to `docId` asc (unchanged from today).

`found`, faceting, filtering, pagination, and the envelope are unchanged; sorting happens after filtering and before pagination (as today), now driven by `rankBy`/`sortBy`.

## API / Client / Types

- `search` gains `rankBy?` and `sortBy?` args (validators as above). `highlight` is populated automatically (no arg).
- `Hit.highlight` type tightens to `Record<string, { snippet: string; matched_tokens: string[] }>` (still an object; empty when no matches).
- Client `search` passes `rankBy`/`sortBy` through; types exported.
- Example: a "Sort" dropdown (Relevance / Price ↑ / Price ↓) sets `sortBy`; product cards render `highlight.name.snippet` via `dangerouslySetInnerHTML` (demo-safe: the marked text comes from the component, values are sample data).

## Error Handling

- `sortBy` entry with an invalid `order` (not `asc`/`desc`) → thrown error.
- `rankBy.fields[].weight` / `rankBy.text` non-number → validator rejects (numeric validators).
- Unknown sort/rank field names are allowed (coerced to 0) — no throw, matching the permissive in-memory model. Documented.
- Highlighting never throws on odd field values — non-string fields are simply skipped.

## Known Limits

- Full-value highlight only (no windowed snippet/length cap yet).
- Highlighting marks any field word whose term matched the query anywhere; it does not re-verify per-doc that the term contributed to that doc's AND match (acceptable, matches loose Typesense behavior).
- Sort/rank read `stored` values in-memory (bounded-scale, same envelope as the rest of search); precomputed sort indexes are Phase 4.
- `<mark>` tag is fixed (not configurable yet).

## Testing Strategy (TDD — colocated `*.test.ts`, convex-test + Vitest)

- **`highlightField` unit (pure):** wraps a matched word; preserves case/punctuation; multiple matches; dedup of `matched_tokens`; no match → null; non-alphanumeric boundaries.
- **Search highlight integration:** a query marks the matching field token; prefix query marks the full term (`run` → `<mark>Running</mark>`); typo query marks the real term; browse mode → `highlight: {}`; a field not in `queryBy` is not highlighted; field absent from projection skipped.
- **`rankBy` blend:** popularity boost reorders results (lower text_match but high popularity ranks above); `text:0` sorts purely by field; reported `text_match` stays the raw relevance.
- **`sortBy`:** `_text_match:desc` matches default; `price:asc` / `price:desc` order numerically; multi-key tie-break; `docId` final tie-break determinism; missing field coerces to 0.
- **Composition:** `rankBy` + `sortBy:_text_match:desc` uses the blended score; `sortBy` field key overrides relevance order.
- **Envelope:** unchanged keys; `highlight` typed object; sorting does not affect `found`/facets.
- **Example smoke:** sort dropdown changes order; highlighted term renders in the grid.
