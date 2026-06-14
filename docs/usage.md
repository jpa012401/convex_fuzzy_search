# FuzzySearch — Usage Guide

How to install, configure, and query the `@elevatech/fuzzy-search` Convex
component. For what it is and how it works internally, see
**[overview.md](./overview.md)**.

- [Install & register](#install--register)
- [Construct the client](#construct-the-client)
- [Create a collection](#create-a-collection)
- [Write documents](#write-documents)
- [Search](#search)
- [The result shape](#the-result-shape)
- [Filtering](#filtering)
- [Faceting](#faceting)
- [Sorting & weighted ranking](#sorting--weighted-ranking)
- [Ranking profiles (configurable windowed re-rank)](#ranking-profiles)
- [Index health (stats)](#index-health-stats)
- [Migration & backfills](#migration--backfills)
- [Gotchas](#gotchas)

---

## Install & register

```sh
npm install @elevatech/fuzzy-search
```

Register the component in your app's `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import fuzzySearch from "@elevatech/fuzzy-search/convex.config";

const app = defineApp();
app.use(fuzzySearch);
export default app;
```

## Construct the client

```ts
import { components } from "./_generated/api";
import { FuzzySearch } from "@elevatech/fuzzy-search";

const search = new FuzzySearch(components.fuzzySearch);
```

Every method takes the Convex `ctx` first. **Mutating** methods
(`createCollection`, `upsert*`, `delete*`, `deleteCollection`, `backfill*`) run
in a mutation (or action); **read** methods (`search`, `getCollection`, `stats`)
run in a query (or action).

## Create a collection

```ts
// in a mutation
await search.createCollection(ctx, {
  name: "products",
  searchFields: ["name", "description"],   // tokenized + indexed for matching
  storedFields: "all",                     // or string[] projection returned in hits
  filterFields: [
    { field: "brand", type: "string" },
    { field: "price", type: "number" },
  ],
  facetFields: ["brand", "category"],
  sortSpecs: [
    [{ field: "price", order: "asc" }],
    [{ field: "price", order: "desc" }],
  ],
  rankProfiles: { /* see "Ranking profiles" below */ },
});
```

| Option | Meaning |
| --- | --- |
| `searchFields` | document fields tokenized + indexed for full-text matching |
| `storedFields` | `"all"` (whole doc) or a `string[]` projection returned in `hits[].document` |
| `filterFields` | `{ field, type: "string" \| "number" }[]` — a field must be declared to appear in `filterBy` |
| `facetFields` | `string[]` — a field must be declared to be requested via `facetBy` |
| `sortSpecs` | `{ field, order }[][]` — composite sort orders to index (each inner array is one spec; numeric fields) |
| `rankProfiles` | named ranking profiles (see below) |

**Validation (at create time):** when `storedFields` is an explicit list, every
`filterFields` / `facetFields` / `sortSpecs` / `rankProfiles`-term field must be
included in it. A `rankProfile.base` must be a declared `sortSpec`. These throw
on violation.

`getCollection(ctx, name)` returns the stored config (`null` if missing);
`deleteCollection(ctx, name)` removes a collection and its indexed data.

## Write documents

```ts
// in a mutation
await search.upsert(ctx, { collection: "products", id: "1", doc: { id: "1", name: "Red Shoe", price: 50 } });
await search.upsertMany(ctx, { collection: "products", docs: [{ id, doc }, …] });
await search.delete(ctx, { collection: "products", id: "1" });
```

- `id` is a **consumer-provided string** and the identity key. Re-upserting an
  `id` **replaces** the prior document (replace, not merge).
- The component does **not** auto-inject `id` into the stored doc — include it in
  `doc` if you want it back in `hits[].document`.
- Writes are synchronous: the change is searchable as soon as the mutation
  commits.

## Search

```ts
// in a query
const result = await search.search(ctx, {
  collection: "products",
  q: "red shoe",
  page: 1,
  perPage: 10,
  // optional:
  queryBy: ["name"],          // restrict matching to these searchFields
  filterBy: "price:<100",     // see Filtering
  facetBy: ["brand"],         // see Faceting
  maxFacetValues: 10,
  sortBy: [{ field: "price", order: "asc" }],   // see Sorting
  rankBy: { text: 1, fields: [{ field: "popularity", weight: 0.1 }] }, // weighted blend
  rank: { profile: "boosted", context: { … } }, // ranking profile (overrides sortBy/rankBy)
});
```

- `q` — empty/whitespace matches all documents (**browse mode**).
- `page` / `perPage` — 1-based page (default `1`), page size (default `10`, max `250`).
- Ordering precedence: **`rank` > `sortBy` / `rankBy`**. If `rank` is present,
  `sortBy` and `rankBy` are ignored.

## The result shape

```jsonc
{
  "found": 2,                 // total matches (or out_of for browse / re-rank)
  "found_approximate": false, // true only when a hot-term scan was capped
  "reranked": true,           // false for a ranking-profile tail page / capped set
  "page": 1,
  "out_of": 6,                // total documents in the collection
  "search_time_ms": 3,
  "hits": [
    {
      "document": { /* stored projection */ },
      "highlight": {          // one entry per searched field that matched; {} in browse
        "name": { "snippet": "Red <mark>Shoe</mark>", "matched_tokens": ["Shoe"] }
      },
      "text_match": 5         // RAW relevance score; higher is better (0 in browse)
    }
  ],
  "facet_counts": [
    { "field_name": "brand", "counts": [{ "value": "Aurora", "count": 2 }] }
  ]
}
```

`text_match` is always the **raw** relevance score (exact > prefix > typo);
`rankBy` / `sortBy` / `rank` change *ordering only*, never this value.

## Filtering

`filterBy` is evaluated against each document's **stored** fields; every
referenced field must be declared in `filterFields`.

| Form | Meaning |
| --- | --- |
| `field:value` | exact match (string or numeric equality) |
| `field:[a,b,c]` | in-set |
| `field:>n` `>=n` `<n` `<=n` | numeric comparator (number fields) |
| `field:[lo..hi]` | inclusive numeric range (number fields) |

Combine with `&&` / `||` and parentheses (`&&` binds tighter). Quote values with
spaces/punctuation: `brand:"Acme Corp"`.

```text
category:Shoes && price:<100
(brand:Aurora || brand:Nimbus) && price:[25..100]
```

Negation (`!=`) and array-valued filter fields are not supported yet.

## Faceting

Pass `facetBy` (declared `facetFields`) to receive `facet_counts`. For an
unfiltered, no-text **browse**, counts come from write-maintained per-value
counters (cheap, exact, whole-collection). With a `filterBy` or text query they
are **query-scoped** — computed over the matched set, sorted by count desc (ties
value asc), capped at `maxFacetValues` (default `10`).

## Sorting & weighted ranking

**`sortBy`** — `{ field: "_text_match" | <numeric field>; order: "asc" | "desc" }[]`,
applied lexicographically; final tie-break is document `id` ascending. A browse
`sortBy` that matches a declared `sortSpec` pages off the sort index (lean);
otherwise it sorts in memory.

**`rankBy`** — `{ text?: number; fields?: { field, weight }[] }`. Ordering score:

```text
score = (text ?? 1) * text_match + Σ ( weight * Number(stored[field] || 0) )
```

A live weighted blend has no fixed key, so an unfiltered browse with `rankBy`
loads the whole collection (exact; fine up to ~tens of thousands of docs). To
scale, either precompute the blend into a numeric field and `sortBy` it, or use a
**ranking profile**.

## Ranking profiles

A configurable, query-time scoring DSL that **softly re-orders** a bounded
candidate window by a weighted blend of typed terms — without scanning the whole
collection. Declared on the collection, driven per query by context + weight
overrides.

### Declare a profile

```ts
rankProfiles: {
  jobsFeed: {
    base: "postedAt:desc",   // a declared sortSpec — the window is taken off this order
    window: 300,             // top-N to re-rank (default 200, max 1000)
    terms: [
      { id: "partner", type: "flag",         field: "partnered",                       weight: 3 },
      { id: "fresh",   type: "recencyDecay",  field: "postedAt", halfLifeMs: 6.048e8,    weight: 2 },
      { id: "near",    type: "geoDistance",   latField: "lat", lngField: "lng", maxKm: 50, weight: 2 },
      { id: "pref",    type: "setBoost",      field: "category", setKey: "prefCats",      weight: 1.5 },
      { id: "rel",     type: "relevance",                                                weight: 1 },
    ],
  },
}
```

### Term types

| `type` | params | contribution |
| --- | --- | --- |
| `field` | `field` | `weight · Number(stored[field])` |
| `flag` | `field`, `equals?` | `weight · (matches ? 1 : 0)` — with `equals`: string equality; without: `true`/`1`/`"true"` |
| `setBoost` | `field`, `setKey` | `weight · (String(stored[field]) ∈ context.sets[setKey] ? 1 : 0)` |
| `recencyDecay` | `field`, `halfLifeMs` (>0) | `weight · 2^(−max(0, now − field) / halfLifeMs)` — `field` must share `now`'s unit (ms) |
| `geoDistance` | `latField`, `lngField`, `maxKm` (>0) | `weight · max(0, 1 − km(stored, origin) / maxKm)` |
| `relevance` | — | `weight · text_match` (0 in browse) |

Score = Σ contributions; missing/NaN values contribute 0.

### Query a profile

```ts
search.search(ctx, {
  collection: "jobs", q: "",
  rank: {
    profile: "jobsFeed",
    context: { now: Date.now(), origin: { lat, lng }, sets: { prefCats: ["Engineering", "Design"] } },
    weights: { near: 3 },   // optional per-term weight override (must be a declared term id)
  },
});
```

- **Context** (`now` / `origin` / `sets`) is the only place per-user / per-moment
  data enters — **nothing is materialized per user**, so it scales to any number
  of users.
- A term whose required context is missing contributes `0` (graceful).
- An unknown `profile`, or an override keyed to an unknown term id, **throws**.

### Semantics & limits

- **Lean & head-only.** The blend re-orders a **top-`window`** taken off `base`
  (browse) or the matched set (text/filter). It does **not** re-order the whole
  collection: a doc far down the base order won't jump to page 1.
- **`reranked`** is `true` for pages served from the re-ranked window; `false`
  for pages beyond the window (served in plain `base` order) or when a text/filter
  candidate set exceeds `window` (capped). `found` is unchanged (soft re-order).
- **Precedence:** `rank` overrides `sortBy`/`rankBy`. Don't rely on the Sort
  dropdown while a profile is active.
- For "sort by X *and* boost", declare a profile whose `base` is that sort order
  and whose terms are the boosts.

## Index health (stats)

`stats(ctx, collection)` returns the live counts held in the aggregate/counter
stores — useful for validating that a collection is fully indexed after a
migration:

```ts
const s = await search.stats(ctx, "products");
// { out_of, facets: [{ field, distinctValues, total }], sortSpecs: [{ specId, count }] }
```

- Every **`sortSpecs[].count`** should equal `out_of` (every doc is indexed in
  every spec).
- A **`facets[].total`** equals the number of docs that *have* that field — it can
  legitimately be `< out_of` for a sparse field, and `0` usually means the facet
  counter was never written (needs a backfill).

## Migration & backfills

Indexes are written **on write**, so a collection indexed under an older version
needs a one-time backfill (or just re-`upsert` the docs, which rebuilds
everything). Each backfill processes one bounded page per call, returns
`{ cursor, done }`, and is idempotent — loop it or self-chain with
`ctx.scheduler` until `done`:

```ts
let cursor = null;
do {
  const r = await search.backfillFacetCountsPage(ctx, { collection: "products", cursor, batch: 100 });
  cursor = r.cursor;
} while (cursor !== null);
```

| Backfill | Rebuilds |
| --- | --- |
| `backfillCounterPage` | the `out_of` / browse doc counter |
| `backfillFiltersPage` | the `filters` index (`filterBy`) |
| `backfillFacetCountsPage` | the facet counters |
| `backfillSortIndexPage` | the sort index (`sortSpecs`) — also the base of ranking profiles |

Matching itself depends on the `terms`/`trigrams` tables, which are *only* built
on write — pre-existing docs return **zero results until re-upserted**. Pick a
`batch` that stays under the 4,096-reads-per-call limit (the filter backfill
rewrites one row per `filterFields` entry, so wide configs use a smaller batch —
the example uses `100`).

> **New config on an existing collection** (e.g. adding `sortSpecs` or
> `rankProfiles`): `createCollection` throws if the collection exists, so the
> config only takes effect on a freshly-created collection. For a large
> collection where `deleteCollection` would exceed read limits, recreate by
> re-seeding into a fresh deployment (the example app does this).

## Gotchas

- **Include `id` in `doc`** if you want it in hits — the component doesn't inject it.
- **`rank` overrides `sortBy`/`rankBy`** — they're mutually exclusive orderings.
- **`found_approximate: true`** means a hot-term scan was capped; `found` is then
  the exact term count for a single-exact-term query, else a bounded lower bound.
- **`reranked: false`** on a profile query means you paged past the re-ranked
  window (base order) or the candidate set was capped.
- **`deleteCollection` on a large collection** can exceed the per-call read limit;
  re-seed (upsert replaces) instead of dropping.
- All sort/rank numeric fields use `Number(...)` coercion; missing/non-numeric → `0`.
