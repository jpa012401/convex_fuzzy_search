# Configurable Windowed Re-Rank ("Ranking Profiles") — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Scope:** A configurable, query-time scoring DSL that softly **re-orders** a bounded candidate set by a weighted blend of typed terms (field / flag / set-boost / recency-decay / geo-distance), driven by declared profiles plus per-query context and weight overrides. Stays lean by re-ranking a **top-N window** taken off a declared base sort, never the whole collection.

## Problem

The component can sort by a fixed field (S4 sort index) and blend numeric fields in memory (`rankBy`), but it can't express the common product-ranking need: *softly* float documents up by a mix of signals chosen at request time — "boost partnered, recent, near me, in my preferred categories" — without hardcoding the formula and without scoring the whole collection.

A soft re-order of the entire list by a per-query blend has **no fixed sort key** (weights and context are query-time), so it can't be exact-over-everything *and* lean. The decided behavior: re-rank a **top-N window** off a declared base order — lean and deep-paginatable along the base order, with the blend reshuffling the head. (This is how Elasticsearch `rescore` / Algolia boosting work at scale.)

## Decisions (locked)

1. **Config lives in both places:** named profiles declared on the collection (`rankProfiles`), with per-query weight overrides and runtime context.
2. **Soft re-order, not filter:** terms change order, never membership. `found` stays `out_of` (or the filtered count) — nothing is dropped.
3. **Windowed for leanness:** the blend is computed over a bounded candidate set (top-N off the base order for browse; the matched set for filtered/text queries), not the whole collection. Head-only: a doc far down the base order won't jump to page 1 of a browse feed.

## Configuration: `rankProfiles`

Declared at `createCollection`:

```ts
rankProfiles?: Record<string, {
  base: string;          // canonical id of a declared sortSpec, e.g. "postedAt:desc"
  window?: number;       // top-N to re-rank; default 200, capped at MAX_RERANK_WINDOW (1000)
  terms: RankTerm[];
}>
```

`RankTerm` (discriminated by `type`; every term has `id: string` and `weight: number`):

| type | params | contribution |
| --- | --- | --- |
| `field` | `field` | `weight · numField(stored, field)` |
| `flag` | `field`, optional `equals` | `weight · (matches ? 1 : 0)` — with `equals`: `String(stored[field]) === String(equals)`; without: value is `true` / `1` / `"true"` |
| `setBoost` | `field`, `setKey` | `weight · (String(stored[field]) ∈ context.sets[setKey] ? 1 : 0)` |
| `recencyDecay` | `field`, `halfLifeMs` | `weight · 2^(−max(0, context.now − numField(stored, field)) / halfLifeMs)` (∈ (0,1]; future timestamps clamp to 1) |
| `geoDistance` | `latField`, `lngField`, `maxKm` | `weight · max(0, 1 − haversineKm(stored, context.origin) / maxKm)` (∈ [0,1]; missing coords or beyond `maxKm` → 0) |

Score = Σ term contributions. All field access uses `numField` (NaN/missing → 0) except `flag`/`setBoost` which stringify. `numField` is the existing `ranking.ts` helper.

**Validation (at `createCollection`):** `base` must equal a declared `sortSpecs` canonical id; every term's `field`/`latField`/`lngField` must be in `storedFields` (when projecting); `window` is clamped to `[1, MAX_RERANK_WINDOW]`; duplicate term `id`s rejected; `setBoost` requires `setKey`, `geoDistance` requires `latField`+`lngField`+`maxKm`, `recencyDecay` requires `halfLifeMs > 0`.

## Query API: `rank`

New optional `search` arg:

```ts
rank?: {
  profile: string;                              // must be a declared rankProfile
  weights?: Record<string, number>;             // override declared term weights by id
  context?: {
    now?: number;                               // ms; required if any recencyDecay term
    origin?: { lat: number; lng: number };      // required if any geoDistance term
    sets?: Record<string, string[]>;            // keyed by setKey; required per setBoost term
  };
}
```

- The profile supplies term *definitions* + default weights; the query supplies **context** (the only entry point for per-user/per-moment data — nothing is materialized per user) and optional **weight overrides** (only for declared term ids; unknown id → throw).
- A term whose required context is absent contributes `0` (e.g. a `geoDistance` term with no `origin`), so a profile degrades gracefully.

## Candidate set + flow

The blend always runs over a **bounded** candidate set; how it's bounded depends on the query:

- **Browse (`rank` present, no `filterBy`, no text):** retrieve the top-`window` docIds off the `base` sortSpec via `pageSortedDocIds(base, 0, window)` (indexed `at()`), load only those.
- **Filtered / text (`rank` present with `filterBy` and/or `q`):** the candidate set is the existing matched/filtered id set (already bounded by S2/S5). It is capped at `window`; if it exceeds the cap, the first `window` (in the path's natural order) are taken and the result is flagged partial.

Then: load the candidate docs, compute the blend per doc, sort by **score desc**, tie-break by **base-order index** (browse) or **docId** (filtered/text), slice the requested page.

### Pagination + the `reranked` flag

- The blend re-orders the candidate window only. A requested page whose start offset is **within** the window is served from the re-ranked slice. A page whose start offset is **beyond** the window falls back to the plain `base` order (browse) — the blend is a head treatment.
- A new boolean `reranked` on the result reports whether the returned page came from the re-ranked window (`true`) or the base-order tail / a capped partial (`false`). For all non-`rank` queries it is `true` (their order is exact).
- `found` is unchanged (`out_of` for browse, matched count for filtered/text) — soft re-order doesn't change membership.

## Leanness analysis

- Window retrieval: `window` `at()` calls on the sort-index aggregate (O(window·log n)) + `window` document reads. With `MAX_RERANK_WINDOW = 1000`, worst case ≈ 2000 reads — under the ~4096 per-query limit. Default `window` 200 keeps it cheap.
- Re-rank: O(window) in memory. No full-collection load. Per-user/per-moment data is query-time context only.

## Module structure

- **`src/component/score.ts`** (new) — the term DSL: `RankTerm` types, `evalTerms(stored, terms, weights, context): number`, the per-type evaluators, `haversineKm`, `recencyDecay`. Pure, unit-tested.
- **`schema.ts` / `collections.ts`** — `rankProfiles` column + `createCollection` arg + validation.
- **`search.ts`** — new branch when `args.rank` is present: resolve profile (+ overrides), build the candidate set (window off base order for browse, or the matched set for filtered/text), `evalTerms` each, sort, page; set `reranked`. Reuses S3 facet counters and S4 `pageSortedDocIds`.
- **`types.ts`** — add `reranked: boolean` to `SearchResult`.
- **client + example** — `rankProfiles` in the `createCollection` types; the example declares a `jobsFeed`-style profile to demo it (or a products "boosted browse" profile over the existing fields).
- Existing `rankBy` (in-memory full-set blend of numeric fields) is **retained** for the exact, small-collection case; `rank` profiles are the lean, configurable path. `rank` and `rankBy` are mutually exclusive on a query (if both given, `rank` wins; document it).

## Error handling

- Unknown `rank.profile`, unknown override term id, or `base` not a declared sortSpec → throw with a clear message.
- Missing required context for a term → that term contributes 0 (graceful), not an error.
- `geoDistance` with non-numeric coords → that doc's term is 0.

## Known limits

- **Head-only for browse:** the blend only reshuffles the top-`window`; a great doc ranked low by the base order won't surface on page 1. Mitigation: choose a base order correlated with general relevance, or raise `window`.
- **Tail pages aren't re-ranked** (base order), flagged via `reranked: false`.
- **Array-valued `setBoost` fields** are tested as a single stringified value (scalar); array overlap is a future extension.
- **`rank` is not reactive-free of cost** like a plain indexed sort — it loads `window` docs per query (bounded, but not O(log n)).
- Exact whole-list soft re-order remains available only via the existing in-memory `rankBy` (full scan; small collections).

## Example (jobs feed)

```ts
rankProfiles: {
  jobsFeed: {
    base: "postedAt:desc",
    window: 300,
    terms: [
      { id: "partner", type: "flag",        field: "partnered",                       weight: 3 },
      { id: "fresh",   type: "recencyDecay", field: "postedAt", halfLifeMs: 6.048e8,    weight: 2 },
      { id: "near",    type: "geoDistance",  latField: "lat", lngField: "lng", maxKm: 50, weight: 2 },
      { id: "pref",    type: "setBoost",     field: "category", setKey: "prefCats",      weight: 1.5 },
    ],
  },
}
// query:
search({ collection: "jobs", q: "", rank: {
  profile: "jobsFeed",
  context: { now: Date.now(), origin: { lat, lng }, sets: { prefCats: ["Engineering", "Design"] } },
  weights: { near: 3 },
}})
```

## Testing strategy (TDD)

- **`score.ts` unit:** each term type's contribution (field, flag with/without `equals`, setBoost membership, recencyDecay half-life + future-clamp, geoDistance haversine + maxKm clamp + missing coords); weight override; absent-context → 0; full `evalTerms` sum.
- **Validation:** undeclared `base`, term field ∉ storedFields, bad/missing type params, duplicate ids, window clamp.
- **Search (browse):** windowed re-order off the base sort matches an in-memory golden over the same window; page within window is re-ranked, page beyond window is base-ordered with `reranked:false`; `found == out_of`.
- **Search (filtered/text):** blend applied over the bounded matched set; capped + `reranked:false` when the matched set exceeds `window`.
- **Context-driven:** changing `origin` / `sets` / `now` changes order without re-indexing; `rank` overrides `rankBy` when both passed.
- Full existing suite stays green; `reranked` is `true` on all non-`rank` paths.
