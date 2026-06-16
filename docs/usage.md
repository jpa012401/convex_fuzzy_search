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
- [Migration & reindex](#migration--reindex)
- [Changing a collection's fields (config sync & reindex)](#changing-a-collections-fields-config-sync--reindex)
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

const search = new FuzzySearch(components.fuzzySearch, {
  collections: {
    products: {
      searchFields: ["name", "description"],
      storedFields: "derived",
      filterFields: [{ field: "brand", type: "string" }],
      // facetFields, sortSpecs, rankProfiles as needed
    },
  },
});
```

Apply the config after deploy with `await search.sync(ctx)` — see
[Changing a collection's fields](#changing-a-collections-fields-config-sync--reindex).
`createCollection` (below) remains available for programmatic / dynamic
collections.

Every method takes the Convex `ctx` first. **Mutating** methods
(`createCollection`, `upsert*`, `delete*`, `deleteCollection`) run
in a mutation (or action); **read** methods (`search`, `getCollection`, `stats`)
run in a query (or action).

## Create a collection

The **recommended** path for most apps is the config object passed to the
constructor + `search.sync(ctx)` — see
[Changing a collection's fields](#changing-a-collections-fields-config-sync--reindex).
`createCollection` below is the explicit / programmatic alternative (useful for
dynamic collection names or tooling that creates collections at runtime).

```ts
// in a mutation
await search.createCollection(ctx, {
  name: "products",
  searchFields: ["name", "description"],   // tokenized + indexed for matching
  storedFields: "derived",                 // "all" | "derived" | string[] — see below
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
| `storedFields` | `"all"` (store whole doc) \| `"derived"` (store only index-relevant fields; app hydrates the rest by id) \| `string[]` (explicit projection) |
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
- Each hit carries its `id` (`hits[].id`); you hydrate the full document by that
  `id` from your own table (the component returns ids + score + highlight, not
  document contents — see [The result shape](#the-result-shape)).
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
  "hits": [
    {
      "id": "1",              // consumer-provided document id
      "score": 5,             // raw relevance (exact > prefix > typo); 0 in browse
      "highlight": {          // one entry per searched field that matched; {} in browse
        "name": { "snippet": "Red <mark>Shoe</mark>", "matched_tokens": ["Shoe"] }
      }
    }
  ],
  "facet_counts": [
    { "field_name": "brand", "counts": [{ "value": "Aurora", "count": 2 }] }
  ]
}
```

The component returns **ids + score + highlight only** — there is no `document`
field in hits. Hydrate full document contents from your own table using the
returned `id` (the example app keeps a `productDocs` table and joins the returned
ids, preserving order).

`score` is always the **raw** relevance score (exact > prefix > typo);
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
  counter was never written (needs a reindex (re-upsert the docs)).

## Migration & reindex

Indexes are written **on write**, so a collection indexed under an older config —
or one that just gained a structural field (`filterFields`/`facetFields`/`sortSpecs`)
via `sync` — needs its existing documents replayed to build the new index rows.
Because the component stores only the index-relevant projection (`storedFields:
"derived"`), it can't rebuild from its own storage: **the app replays its own copy
of each document** through `upsert`/`upsertMany`, which rebuilds every index row
(postings, filters, facets, sort) under the current config. Then clear the flag:

```ts
// Page your own table and re-upsert; self-chain with ctx.scheduler until done.
await search.upsertMany(ctx, { collection: "products", docs: pageOfDocs });
// ...when every page has been replayed:
await search.clearPending(ctx, "products");
```

`sync` records which fields await reindex; read them with
`await search.pendingFields(ctx, "products")` and clear with
`search.clearPending(...)`. See
[Changing a collection's fields](#changing-a-collections-fields-config-sync--reindex)
for the full flow, and the example app's `reindex` mutation for a self-chaining
driver that pages its own `productDocs` table.

Matching itself depends on the `terms`/`trigrams` tables, which are *only* built
on write — pre-existing docs return **zero results until re-upserted**. Replay in
bounded pages (the example uses `100`) to stay under the 4,096-reads-per-call limit.

## Changing a collection's fields (config sync & reindex)

Declare collections in code and apply changes with `sync` instead of calling
`createCollection` by hand:

```ts
const search = new FuzzySearch(components.fuzzySearch, {
  collections: {
    products: {
      searchFields: ["name", "description"],
      storedFields: "derived", // component stores only index-relevant fields
      filterFields: [{ field: "brand", type: "string" }],
      rankProfiles: { /* ... */ },
    },
  },
});

// Wire once; run after deploy.
export const sync = mutation({ args: {}, handler: (ctx) => search.sync(ctx) });
```

`sync(ctx)` is idempotent and reads no documents. Two cases when you edit the config:

- **Metadata change** (rankProfiles, weights, searchFields): applies in place,
  O(1). Nothing else to do.
- **Structural addition** (new `filterFields` / `facetFields` / `sortSpecs`):
  `sync` updates the row and marks the field *pending* — existing documents have
  no index rows for it yet. Reindex them, then clear the flag:

```ts
await search.pendingFields(ctx, "products"); // -> ["brand"] while pending
// Replay your own docs through upsert (rebuilds the new field's index rows),
// paging a table you own — see the example app's self-chaining `reindex`.
await search.clearPending(ctx, "products");  // mark fully reindexed
```

Until the reindex completes, queries on the new field return **incomplete**
(not erroneous) results. Removing a field is lazy — the dead index rows are
harmless and left in place.

Reindex is **app-driven**: with `storedFields: "derived"` the component keeps
only index-relevant fields, so it cannot rebuild a new field from its own
storage — the app replays its serving copy of each document back through
`upsert`/`upsertMany`. Because writes are explicit (like the aggregate
component), **dashboard edits and `npx convex import` to your app tables do not
reach the component** — replay the affected documents to resync.

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
