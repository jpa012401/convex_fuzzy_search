# Convex Fuzzy Search

[![npm version](https://badge.fury.io/js/@elevatech%2Ffuzzy-search.svg)](https://badge.fury.io/js/@elevatech%2Ffuzzy-search)

A [Convex](https://convex.dev) component for full-text search — tokenized
matching, prefix (search-as-you-type), typo tolerance, relevance ranking,
highlighting, weighted ranking, multi-key sort, filtering, and faceting —
running entirely inside your Convex deployment. Writes are durable Convex
mutations and become searchable immediately. No external service, no sync
pipeline.

> **Independent, not affiliated.** This is a from-scratch implementation. It is
> **not** built on, a client for, or affiliated with Typesense or Elasticsearch.
> It borrows two of their *ideas*: a **Typesense-style result envelope**
> (`{ found, hits, facet_counts, … }`, so an existing Typesense-style UI maps
> cleanly onto it) and an **Elasticsearch-style weighted ranking** (a
> `field_value_factor`-like blend). Everything is plain Convex tables, queries,
> and mutations — nothing leaves your deployment.

**Documentation:** [Overview](./docs/overview.md) (what it is + how it works) ·
[Usage guide](./docs/usage.md) (install, API, ranking profiles, reindex). This
README is the quick tour; the guides are the full reference.

Found a bug? Feature request?
[File it here](https://github.com/elevatech/fuzzy-search/issues).

## Features

- **Tokenized full-text search** — lowercase + Unicode-alphanumeric
  tokenization; multi-word queries combine with AND.
- **Prefix matching (search-as-you-type)** — the final query token matches any
  indexed term it prefixes.
- **Typo tolerance** — misspelled tokens still match via a trigram index plus a
  bounded Levenshtein check, with a per-token-length typo budget.
- **Relevance ranking** — hits scored by `text_match` (exact > prefix > typo),
  best-first.
- **Highlighting** — automatic; each matched searched field returns
  `{ snippet, matched_tokens }` with matched words wrapped in `<mark>…</mark>`
  (rest HTML-escaped, safe to render).
- **Weighted ranking (`rankBy`)** — blend relevance with weighted numeric fields
  to boost by popularity, price, an affinity score, etc.
- **Multi-key sort (`sortBy`)** — order by a list of sort keys over `_text_match`
  or numeric fields, asc/desc.
- **Structured filtering (`filterBy`)** — exact, in-set, numeric comparators and
  ranges, combined with `&&`/`||` and parentheses.
- **Faceting (`facet_counts`)** — value counts for declared facet fields.
- **Result envelope** — `{ found, found_approximate, reranked, page, out_of,
  hits, facet_counts }`.
- **Synchronous writes** — searchable the moment the mutation commits; no
  indexing lag.
- **Collections** — named, with their own search fields and stored projection.
- **Scales** — counters, indexed filtering, facet counters, indexed sort, and
  hot-term bounding keep queries off the full collection (see [Scale](#scale)).

## Installation

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

## Quick start

```ts
import { components } from "./_generated/api";
import { FuzzySearch } from "@elevatech/fuzzy-search";

const search = new FuzzySearch(components.fuzzySearch);
```

Create a collection and insert documents from a **mutation**:

```ts
await search.createCollection(ctx, {
  name: "products",
  searchFields: ["name", "description"],
  storedFields: "all",
});

await search.upsert(ctx, {
  collection: "products",
  id: "1",
  doc: { name: "Red Shoe", price: 50 },
});
```

Search from a **query**:

```ts
const results = await search.search(ctx, {
  collection: "products",
  q: "red shoe",
  page: 1,
  perPage: 10,
});
```

See [`example/convex/products.ts`](./example/convex/products.ts) for a complete,
runnable example.

## Result shape

```jsonc
{
  "found": 2,              // total matches across all pages
  "found_approximate": false, // true only when a hot-term scan was capped (see Scale)
  "reranked": true,
  "page": 1,
  "out_of": 6,             // total documents in the collection
  "hits": [
    {
      "document": { /* stored projection of the matched doc */ },
      "highlight": {       // one entry per searched field that matched; {} in browse
        "name": { "snippet": "Red <mark>Shoe</mark>", "matched_tokens": ["Shoe"] }
      },
      "text_match": 5      // RAW relevance score; higher is better (0 in browse)
    }
  ],
  "facet_counts": [        // one entry per requested facetBy field; [] if none
    { "field_name": "brand",
      "counts": [{ "value": "Aurora", "count": 2 }, { "value": "Nimbus", "count": 1 }] }
  ]
}
```

## API

All methods take Convex `ctx` first. Mutating methods run in a mutation (or
action); read methods in a query (or action).

### `createCollection(ctx, { name, searchFields, storedFields?, filterFields?, facetFields?, sortSpecs? })`

Creates a collection.

- `searchFields` — fields tokenized and indexed for matching.
- `storedFields` — projection returned in hits: `"all"` (whole doc) or a
  `string[]`.
- `filterFields` — `{ field, type: "string" | "number" }[]` declaring which
  fields may appear in `filterBy` and how they compare. A field must be declared
  to be filterable.
- `facetFields` — `string[]` declaring which fields may be requested via
  `facetBy`.
- `sortSpecs` — `{ field, order: "asc" | "desc" }[][]` declaring composite sort
  orders to index for scalable unfiltered browse-by-sort (each inner array is
  one ordered spec; a single field is a length-1 spec). All sort fields are
  numeric.

When `storedFields` is an explicit list, every `filterFields`, `facetFields`,
and `sortSpecs` field **must** be included in it (validated at create time).

### `getCollection(ctx, name)` · `deleteCollection(ctx, name)`

Read the stored config (`null` if missing); delete a collection and its indexed
data.

### `upsert(ctx, { collection, id, doc })` · `upsertMany(ctx, { collection, docs })` · `delete(ctx, { collection, id })`

Insert/replace one document (by consumer-provided string `id`; re-upsert
**replaces**, not merges), the batch form, or remove one. The component does not
auto-inject `id` into the stored doc — include it in `doc` if you want it back in
hits.

### `search(ctx, { collection, q, page?, perPage?, queryBy?, filterBy?, facetBy?, maxFacetValues?, rankBy?, sortBy? })`

Runs a search and returns the [result shape](#result-shape) above.

- `q` — query string. Empty/whitespace matches all documents (browse mode).
- `page` / `perPage` — 1-based page (default `1`), page size (default `10`, max
  `250`).
- `queryBy` — `string[]` restricting which fields may match (subset of
  `searchFields`).
- `filterBy` — a filter expression (see [Filtering](#filtering)). Empty is
  ignored.
- `facetBy` — `string[]` of declared facet fields to count. An undeclared field
  throws.
- `maxFacetValues` — cap on values returned per facet (default `10`).
- `rankBy` / `sortBy` — change **ordering only**; they never change the reported
  `text_match` (see below).

## Ranking & sort

**`text_match` is always the RAW relevance score** (exact > prefix > typo). Per
token, exact = `3`, prefix = `2`, typo = `2 − 0.5 × distance`; a document's score
is the sum of its best per-token scores. `rankBy` and `sortBy` only reorder.

**`rankBy`** — `{ text?: number; fields?: { field, weight }[] }`. Ordering score:

```text
score = (text ?? 1) * text_match + Σ ( weight * Number(stored[field] || 0) )
```

A missing/non-numeric field contributes `0`; `text` defaults to `1`. (Tip: to
scale a *personalized* weighted sort, precompute the blend into a numeric field
and `sortBy` that — see the example's `affinity` field.)

**`sortBy`** — `{ field: "_text_match" | <numeric field>; order: "asc" | "desc" }[]`,
applied lexicographically; final tie-break is document `id` ascending. Default is
`[{ field: "_text_match", order: "desc" }]`.

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
spaces or punctuation: `brand:"Acme Corp"`. Comparators/ranges require a
`type: "number"` field; misuse or an undeclared field throws.

```text
category:Shoes && price:<100
(brand:Aurora || brand:Nimbus) && price:[25..100]
```

> Negation (`!=`) and array-valued filter fields are **not** supported yet.

## Faceting

Pass `facetBy` (declared `facetFields`) to receive `facet_counts`. For an
unfiltered, no-text browse, counts come from write-maintained per-value counters
(cheap, exact, whole-collection). When a `filterBy` or text query is present,
counts are **query-scoped** — computed over the current result set, sorted by
count desc (ties by value asc), capped at `maxFacetValues`. Missing/`null` values
are skipped; values compare as strings. Array-valued facet fields are not yet
supported.

## Behavior

- **Tokenization** — lowercased, split on any non-(Unicode letter/number); no
  stopwords, no stemming (`"Red-Shoe!"` → `["red", "shoe"]`).
- **Multi-word = AND** — every token must be present.
- **Prefix on the last token only**; earlier tokens match in full (exact/typo).
- **Typo budget by length** — ≤ 3 chars: 0 typos, 4–7: 1, ≥ 8: 2.
- **Empty query = match-all**, paginated, `text_match` `0`.
- **Synchronous** — committed writes are immediately searchable.
- **Replace-by-id** — re-upserting an `id` fully replaces the prior document.

## Scale

Read paths stay off the full collection at large scale (the Phase 4 program,
S1–S5, all implemented):

- **`out_of`** is an O(log n) aggregate count — no scan.
- **Text queries** load only matched documents (postings candidates), and the
  matching is **driver-token bounded**: the most selective token drives the AND
  and the rest are verified per-doc, so reads scale with result size, not with
  how common a word is.
- **Filtering** resolves through a write-maintained `filters` index — `filterBy`
  (and browse+filter) reads only matching ids, no scan.
- **Browse + facets** are served from write-maintained per-value counters; **browse
  + a declared `sortBy`** pages off a write-maintained composite-key sort index.
- **Hot terms are bounded.** A driver token matching more rows than the internal
  budget (~4000) is capped; the result is returned with `found_approximate: true`
  (and `found` is the exact term count for a single-exact-term query).

**Remaining limits.** Browse with a **live `rankBy`** (weighted blend, no fixed
key) still loads the collection — precompute the blend into a numeric field and
`sortBy` it to scale. Very-broad query-scoped facet counts still tally in-memory
over the matched set. No `filterBy` negation, no array-valued fields, no async
bulk import yet (`upsertMany` runs in one mutation, bounded by per-mutation
limits). `deleteCollection` reads index rows in one mutation, so it is bounded;
re-seed (upsert replaces) for very large collections.

### Migration: reindex after a config change

Indexes are populated **on write**, so documents indexed under an earlier config —
or a collection that just gained a structural field (`filterFields`/`facetFields`/
`sortSpecs`) via `sync` — need their existing documents replayed to build the new
index rows. Because the component stores only the index-relevant projection
(`storedFields: "derived"`), it can't rebuild from its own storage: **the app
replays its own copy** of each document through `upsert`/`upsertMany`, which
rebuilds every index row (postings, filters, facets, sort) under the current
config. `sync` flags fields awaiting reindex (`search.pendingFields`); clear them
with `search.clearPending` once the replay finishes. See
[`example/convex/products.ts`](./example/convex/products.ts) for the self-chaining
`reindex` driver that pages the app's own `productDocs` table.

- Matching depends on the `terms`/`trigrams` tables — pre-existing docs return
  **zero results until re-upserted**.
- Replay in bounded pages (the example uses `100`) to stay under Convex's
  4,096-reads-per-call limit.

## Running the example

[`example/`](./example) is an ecommerce storefront demo (React + Vite). From the
repo root:

```sh
npm install
npm run dev            # Convex backend (prompts to deploy; watches + rebuilds)
npm run dev:frontend   # Vite frontend (second terminal)
```

Click **Seed 6** to create the `products` collection and load samples, then
search (`aurora shoe`, `aur` for prefix, `aurra` for typo tolerance).

**Stress test —** [`example/convex/dataset.ts`](./example/convex/dataset.ts)
deterministically generates 5,000 products with rich fields plus a precomputed
**`affinity`** score (match to a demo user profile), which powers the
personalized weighted sort. Load it via the **Load 5k** button, or:

```sh
npx convex run products:startSeed '{"total":5000}'   # background load
npx convex run products:benchmark '{}'               # feature + timing sweep
```

## Design specs

The multi-phase design lives in
[`docs/superpowers/specs/`](./docs/superpowers/specs/):

- [Phase 1 — exact tokenized search](./docs/superpowers/specs/2026-06-13-typesense-convex-phase1-design.md)
- [Phase 2 — filtering & faceting](./docs/superpowers/specs/2026-06-13-typesense-convex-phase2-design.md)
- [Phase 3 — typo tolerance, weighted ranking & highlighting](./docs/superpowers/specs/2026-06-13-typesense-convex-phase3-design.md)
- Phase 4 — arbitrary-scale hardening (S1 lean reads, S2 indexed filtering, S3
  facet counters, S4 sort indexes, S5 hot-term bounding)
