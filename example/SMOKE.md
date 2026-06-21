# Smoke Test: Full Lifecycle (empty → populated → search → update → delete → empty)

Task 12 real-deployment smoke against the local Convex backend (`http://127.0.0.1:3212`).
All commands use `npx convex run products:<fn>` (no `--local`/`--prod` flag; local is already selected).

---

## Step 1 — Empty Baseline

```
npx convex run products:indexStats '{}'
```

**Output (verbatim):**
```
✖ Failed to run function "products:indexStats":
Error: [Request ID: d8a13d36485ec987] Server Error
Uncaught Error: Uncaught Error: CollectionNotFound: "products"
    at requireCollection (../../src/component/collections.ts:34:9)
    at async handler (../src/component/stats.ts:29:15)
```

**Result:** PASS — truly empty starting state confirmed.

---

## Step 2 — Seed (empty → 6 products via app→sync→component)

```
npx convex run products:seed '{}'
```

**Output (verbatim):**
```json
{
  "seeded": 6
}
```

```
npx convex run products:indexStats '{}'
```

**Output (verbatim, excerpt):**
```json
{
  "out_of": 6,
  "facets": [
    { "distinctValues": 3, "field": "brand", "total": 6, "truncated": false },
    { "distinctValues": 4, "field": "category", "total": 6, "truncated": false },
    { "distinctValues": 0, "field": "subcategory", "total": 0, "truncated": false },
    { "distinctValues": 0, "field": "inStock", "total": 0, "truncated": false }
  ],
  "sortSpecs": [
    { "count": 6, "specId": "price:asc" },
    { "count": 6, "specId": "price:desc" },
    { "count": 6, "specId": "popularity:desc" }
  ]
}
```

**Result:** PASS — `out_of: 6` confirms all 6 products indexed (Aurora Running Shoe, Aurora Trail Shoe, Nimbus Rain Jacket, Nimbus Wool Hat, Vertex Yoga Mat, Vertex Water Bottle). `facets.brand.total: 6` matches.

---

## Step 3 — Search + Hydrate

```
npx convex run products:searchProducts '{"q":"running shoe"}'
```

**Output (verbatim):**
```json
{
  "facet_counts": [],
  "found": 1,
  "found_approximate": false,
  "hits": [
    {
      "document": {
        "brand": "Aurora",
        "category": "Shoes",
        "description": "lightweight road running shoe",
        "image": "https://picsum.photos/seed/aurora-running/300",
        "name": "Aurora Running Shoe",
        "popularity": 50,
        "price": 89,
        "releasedAt": 1782045474767
      },
      "highlight": {
        "description": { "matched_tokens": ["running", "shoe"], "snippet": "lightweight road <mark>running</mark> <mark>shoe</mark>" },
        "name": { "matched_tokens": ["Running", "Shoe"], "snippet": "Aurora <mark>Running</mark> <mark>Shoe</mark>" }
      },
      "id": "jd7cvx7dypamhzja1empr64vxn892jqw",
      "score": 1
    }
  ],
  "out_of": 6,
  "page": 1,
  "reranked": true
}
```

**Result:** PASS — component returns app-table `_id` ("jd7cvx7dypamhzja1empr64vxn892jqw"), app hydrates full product fields from `productDocs`. Flow confirmed: app→sync→component→search→hydrate.

---

## Step 4 — AND Semantics

```
npx convex run products:searchProducts '{"q":"aurora trail"}'
```

**Output (verbatim):**
```json
{
  "found": 1,
  "hits": [
    {
      "document": { "brand": "Aurora", "category": "Shoes", "name": "Aurora Trail Shoe", "price": 109 },
      "id": "jd71s05wdff9hxmwg13am0s3f5893750",
      "score": 1
    }
  ],
  "out_of": 6
}
```

**Result:** PASS — query "aurora trail" returns ONLY Aurora Trail Shoe (both tokens required). Nimbus Rain Jacket (has neither token) and Aurora Running Shoe (has "aurora" but not "trail") are absent. App-side `reverifyAnd` over native OR confirmed.

---

## Step 5 — Filter/Facet

### Without facets (F8 path — scanns searchDocs, correct):

```
npx convex run products:searchProducts '{"q":"","filterBy":"brand:\"Aurora\""}'
```

**Output:** `found: 2`, both Aurora shoes hydrated correctly. PASS.

```
npx convex run products:searchProducts '{"q":"","filterBy":"brand:\"Nimbus\""}'
```

**Output:** `found: 2`, both Nimbus products hydrated correctly. PASS.

### With facets (legacy filterPostings path — STALE DATA BUG):

```
npx convex run products:searchProducts '{"q":"","filterBy":"brand:\"Aurora\"","facetBy":["brand","category"]}'
```

**Output:** `found: 124, hits: [{ document: {}, ... }, ...]` (10 hits with empty `document`)

**Result:** FAIL — stale `filterPostings` rows from the previous large (5000-doc) dataset were not cleared when `seed` called `deleteCollection`. The `resolveAstToDocIds` path (used when `hasFacets=true` + empty-q + filter) reads from the `filterPostings` table, which still contains rows from the old dataset. The app's `productDocs` rows for those IDs no longer exist, so hydration returns `document: {}`.

**Root cause:** The `cleanupCollectionBatchInternal` function (in `src/component/collections.ts`) only deletes `searchDocs` rows, not `filterPostings` rows. The new write path (`write.ts`, rewritten in commit e7098e0) no longer writes to `filterPostings` at all — the `addStringPosting`/`addNumericPosting` functions exist in `filterPostings.ts` but are not called from `write.ts`. The `filterPostings` table retains stale data from the pre-rewrite era and is never cleaned up on `deleteCollection`.

**Scope:** Affects empty-q + filter + facet queries that fall through to the `resolveAstToDocIds` path in `search.ts` (lines 261–279). Text queries with filter (F2 path via `resolveEqFilters` + slot columns) work correctly.

---

## Step 6 — Update

```
npx convex run products:updateProduct '{"id":"jd7cvx7dypamhzja1empr64vxn892jqw","doc":{"name":"Aurora Sprint Shoe","description":"ultralight sprint competition shoe","brand":"Aurora","category":"Shoes","price":129,"popularity":75,"image":"https://picsum.photos/seed/aurora-sprint/300"}}'
```

**Output:** `{ "ok": true }`

```
npx convex run products:searchProducts '{"q":"sprint shoe"}'
```

**Output:** `found: 1`, hit is `"Aurora Sprint Shoe"` with updated description. PASS.

```
npx convex run products:searchProducts '{"q":"running shoe"}'
```

**Output:** `found: 0` — old text no longer matches. PASS.

**Result:** PASS — re-index through the full lifecycle works correctly.

---

## Step 7 — Delete

```
npx convex run products:deleteProduct '{"id":"jd7cvx7dypamhzja1empr64vxn892jqw"}'
```

**Output:** `{ "ok": true }`

```
npx convex run products:searchProducts '{"q":"sprint shoe"}'
```

**Output:** `{ "found": 0, "out_of": 5, "hits": [] }`

**Result:** PASS — deleted product is gone, `out_of` decremented to 5.

---

## Step 8 — Teardown

```
npx convex run products:dropProducts '{}'
```

**Output:** `{ "ok": true }`

```
npx convex run products:indexStats '{}'
```

**Output:**
```
✖ Failed to run function "products:indexStats":
Error: CollectionNotFound: "products"
```

**Result:** PASS — collection fully drained back to empty.

---

## Step 9 — Native Search Features (prefix, typo, highlight): LIVE-ONLY

These behaviors require native Convex full-text search and cannot be tested via `vitest` / `convex-test`.
They are `it.skip`'d in `src/component/search.test.ts` with a reference to this section.

### 9a — Prefix search-as-you-type

```
npx convex run products:searchProducts '{"q":"runnin"}'
```

**Expected:** `found >= 1`, hits include "Aurora Running Shoe" and "Aurora Trail Shoe" (prefix "runnin" matches "running").
Confirms native prefix expands the last token.

### 9b — Prefix only applies to last token

```
npx convex run products:searchProducts '{"q":"shoe runnin"}'
```

**Expected:** `found >= 1` (both "shoe" and prefix "runnin" match Aurora Running Shoe, after AND re-verify).

```
npx convex run products:searchProducts '{"q":"runnin shoe"}'
```

**Expected:** `found == 0` (prefix only on last token — "shoe" is exact, "runnin" is not the last token, so no prefix expansion for it; "runnin" exact-matches nothing).

### 9c — Typo tolerance (native fuzzy matching)

```
npx convex run products:searchProducts '{"q":"runing"}'
```

**Expected:** `found >= 1` — native search tolerates 1 edit ("runing" → "running").

```
npx convex run products:searchProducts '{"q":"runnixx"}'
```

**Expected:** `found == 0` — 2+ edits from "running" exceeds the native typo budget.

### 9d — Prefix query highlights the expanded term

```
npx convex run products:searchProducts '{"q":"runnin"}'
```

**Expected:** in the returned hit's `highlight.name.snippet`, the matched token is wrapped as `<mark>Running</mark>` (the full expanded word, not just the prefix "runnin").

## Summary

| Step | Description | Result |
|------|-------------|--------|
| 1 | Empty baseline — CollectionNotFound | PASS |
| 2 | Seed 6 products via app→sync→component; out_of=6 | PASS |
| 3 | Text search + hydrate from productDocs | PASS |
| 4 | AND semantics ("aurora trail" → only Aurora Trail Shoe) | PASS |
| 5a | Filter without facets (F8/searchDocs path) | PASS |
| 5b | Filter + facets (legacy filterPostings path, stale data) | **FAIL** |
| 6 | Update product; re-search confirms change | PASS |
| 7 | Delete product; re-search confirms gone | PASS |
| 8 | dropProducts; indexStats throws CollectionNotFound | PASS |
| 9a | Prefix search-as-you-type | live-only |
| 9b | Prefix applies only to last token | live-only |
| 9c | Typo tolerance (within budget / exceeds budget) | live-only |
| 9d | Prefix query highlights expanded term | live-only |

**Bug found:** `filterPostings` table retains stale rows after `deleteCollection` because `cleanupCollectionBatchInternal` does not clear `filterPostings`. The new write path (`write.ts` rewrite, commit e7098e0) no longer writes to `filterPostings`, leaving it as dead stale data that the legacy `resolveAstToDocIds` read path still consults for empty-q + filter + facet queries.

**Fix direction:** Either (a) purge `filterPostings` for the collection in `cleanupCollectionBatchInternal`, or (b) remove the `resolveAstToDocIds` path from `search.ts` entirely and replace it with the `runEmptyQFilterQuery` (searchDocs slot scan) path, which correctly uses only the current slot-based write path. Option (b) is likely already the intended post-rewrite direction given the TODO comments in `search.ts`.
