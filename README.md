# Convex Fuzzy Search

[![npm version](https://badge.fury.io/js/@elevatech%2Ffuzzy-search.svg)](https://badge.fury.io/js/@elevatech%2Ffuzzy-search)

A [Convex](https://convex.dev) component providing exact, tokenized full-text
search with [Typesense](https://typesense.org)-shaped results — entirely inside
your Convex deployment. No external search service to run, no sync pipeline to
maintain: writes are durable Convex mutations and become searchable
immediately.

> **Status.** This release delivers tokenized search with prefix matching,
> typo tolerance, relevance ranking, highlighting, weighted ranking +
> multi-key sort, and structured filtering + faceting, all with
> Typesense-shaped output. Large-scale hardening is
> planned for a later phase — see [Roadmap & limitations](#roadmap--limitations)
> and the [design specs](#design-specs). Document and result shapes are designed
> to be forward-compatible with those phases.

Found a bug? Feature request?
[File it here](https://github.com/elevatech/fuzzy-search/issues).

## Features

- **Tokenized full-text search** — lowercase + Unicode alphanumeric
  tokenization, multi-word queries combined with AND semantics.
- **Prefix matching (search-as-you-type)** — the final query token matches any
  indexed term it is a prefix of, so results update as the user types.
- **Typo tolerance** — misspelled tokens still match via a trigram index plus a
  bounded Levenshtein distance check, with a per-token-length typo budget.
- **Relevance ranking** — hits are scored by a `text_match` value (exact beats
  prefix beats typo) and returned best-first.
- **Highlighting** — automatic, no extra argument: each searched field that
  matched returns `highlight[field] = { snippet, matched_tokens }`, where
  `snippet` is the field text with matched words wrapped in `<mark>…</mark>`
  (other text HTML-escaped, so it is safe to render) and `matched_tokens` lists
  the matched surface forms.
- **Weighted ranking (`rankBy`)** — blend the relevance score with weighted
  numeric fields (Elasticsearch `field_value_factor` style) to boost by
  popularity, price, etc.
- **Multi-key sort (`sortBy`)** — order results by a list of sort keys over
  `_text_match` or numeric stored fields, ascending or descending.
- **Structured filtering** — constrain results with a Typesense-style
  `filter_by` expression: exact matches, in-set membership, numeric comparators
  and ranges, combined with `&&`/`||` and parentheses.
- **Faceting** — request `facet_counts` for declared facet fields, computed over
  the current filtered + searched result set.
- **Typesense-shaped output** — `{ found, page, out_of, search_time_ms, hits,
  facet_counts }` so you can map an existing Typesense UI onto Convex.
- **Synchronous writes** — documents are searchable the moment the upsert
  mutation commits. No background indexing, no eventual consistency.
- **Collections** — named collections with their own configurable search fields
  and stored projection.
- **Field-scoped queries** — restrict matching to specific fields per query via
  `queryBy`.
- **Browse mode** — an empty query returns all documents (match-all),
  paginated.
- **Fully in-Convex** — no external service; everything is plain Convex tables,
  queries, and mutations.

## Installation

Install the package:

```sh
npm install @elevatech/fuzzy-search
```

Then register the component in your app's `convex/convex.config.ts`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import fuzzySearch from "@elevatech/fuzzy-search/convex.config";

const app = defineApp();
app.use(fuzzySearch);

export default app;
```

## Quick start

Construct a `FuzzySearch` client with the installed component reference,
then call its methods from your own Convex functions.

```ts
import { components } from "./_generated/api";
import { FuzzySearch } from "@elevatech/fuzzy-search";

const search = new FuzzySearch(components.fuzzySearch);
```

Create a collection and insert documents from a **mutation**:

```ts
// in a mutation handler
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
// in a query handler
const results = await search.search(ctx, {
  collection: "products",
  q: "red shoe",
  page: 1,
  perPage: 10,
});
```

See [`example/convex/products.ts`](./example/convex/products.ts) for a complete,
runnable example.

## Search output shape

`search` returns a Typesense-shaped result:

```jsonc
{
  "found": 2,             // total matches across all pages
  "page": 1,              // the page that was returned
  "out_of": 6,            // total documents in the collection
  "search_time_ms": 3,    // server-side time for this query
  "hits": [
    {
      "document": { /* stored projection of the matched doc */ },
      "highlight": {      // one entry per searched field that matched; {} in browse mode
        "name": {
          "snippet": "Red <mark>Shoe</mark>",   // matched words wrapped, rest HTML-escaped
          "matched_tokens": ["Shoe"]            // matched surface forms (deduped)
        }
      },
      "text_match": 5     // RAW relevance score; higher is better (0 in browse mode)
    }
  ],
  "facet_counts": [       // one entry per requested facetBy field; [] if none requested
    {
      "field_name": "brand",
      "counts": [
        { "value": "Aurora", "count": 2 },
        { "value": "Nimbus", "count": 1 }
      ]
    }
  ]
}
```

## API reference

All methods take the Convex `ctx` as their first argument. Mutating methods must
be called from a mutation (or action); read methods from a query (or action).

### `createCollection(ctx, { name, searchFields, storedFields?, filterFields?, facetFields? })`

Creates a collection. `searchFields` is the list of document fields that are
tokenized and indexed for matching. `storedFields` controls the projection
returned in hits — `"all"` (default behavior in the example) stores the whole
document, or pass a `string[]` to store only those fields.

- `filterFields` — optional `{ field: string, type: "string" | "number" }[]`
  declaring which fields may appear in a `filter_by` expression and how each is
  compared (string equality vs. numeric). A field must be declared here to be
  filterable.
- `facetFields` — optional `string[]` declaring which fields may be requested via
  `facetBy`.

When `storedFields` is an explicit list (not `"all"`), every `filterFields`
field and every `facetFields` field **must** be included in `storedFields` —
this is validated at `createCollection` time and throws otherwise. (With
`storedFields: "all"` the whole document is stored, so no subset check applies.)

Call from a mutation.

### `getCollection(ctx, name)`

Returns the collection's stored config, or `null`/`undefined` if it does not
exist. Useful for "create if missing" idempotent setup. Call from a query.

### `deleteCollection(ctx, name)`

Deletes a collection and its indexed data. Call from a mutation.

### `upsert(ctx, { collection, id, doc })`

Inserts or replaces a single document. `id` is a consumer-provided string and is
the identity key — upserting the same `id` again **replaces** the prior
document (replace semantics, not merge). `doc` is the record to index and store.
Call from a mutation.

### `upsertMany(ctx, { collection, docs })`

Batch form of `upsert`. `docs` is an array of `{ id, doc }` entries. Call from a
mutation.

### `delete(ctx, { collection, id })`

Removes the document with the given `id` from the collection. Call from a
mutation.

### `search(ctx, { collection, q, page?, perPage?, queryBy?, filterBy?, facetBy?, maxFacetValues?, rankBy?, sortBy? })`

Runs a search and returns a [`SearchResult`](#search-output-shape).

- `q` — the query string. Empty/whitespace-only `q` matches all documents
  (browse mode).
- `page` — 1-based page number. Defaults to `1`.
- `perPage` — page size. Defaults to `10`, capped at `250`.
- `queryBy` — optional `string[]` restricting which fields are allowed to match
  for this query (a subset of the collection's `searchFields`). Omit to match
  across all indexed fields.
- `filterBy` — optional `filter_by` expression (see
  [Filtering](#filtering-filter_by)) that constrains the result set by field
  value. Empty/whitespace-only is ignored.
- `facetBy` — optional `string[]` of facet fields to count over the result set.
  Each must be a declared `facetFields` field, otherwise the query throws.
- `maxFacetValues` — optional cap on how many distinct values are returned per
  facet field. Defaults to `10`.
- `rankBy` — optional weighted-ranking config that changes result **ordering**
  (see [Weighted ranking](#weighted-ranking-rankby)). Does not change the
  reported `text_match`.
- `sortBy` — optional list of sort keys that changes result **ordering** (see
  [Multi-key sort](#multi-key-sort-sortby)). Does not change the reported
  `text_match`.

Every hit also carries automatic **highlighting** — see
[Highlighting](#highlighting-highlight). Call from a query.

## Highlighting (`highlight`)

Highlighting is automatic; there is no argument to enable it. For each hit, every
**searched field** (the collection's `searchFields`, or the `queryBy` subset when
`queryBy` is provided) that contains a matched word gets an entry in
`highlight`:

```jsonc
"highlight": {
  "name": {
    "snippet": "Red <mark>Shoe</mark>",   // field text, matched words wrapped
    "matched_tokens": ["Shoe"]            // matched surface forms (deduped)
  }
}
```

- `snippet` is the **full field value** with each matched word wrapped in
  `<mark>…</mark>`; all other characters are HTML-escaped (`&`, `<`, `>`), so the
  snippet is safe to render as HTML.
- `matched_tokens` is the deduped list of the original surface forms (preserving
  case and accents) of the words that were marked.
- A field with no matched word is omitted. In **browse mode** (empty/whitespace
  `q`), nothing matched, so `highlight` is `{}`.

## Weighted ranking (`rankBy`)

`rankBy` blends the relevance score with weighted numeric stored fields
(Elasticsearch `field_value_factor` style) to influence **ordering only** — e.g.
boost popular or higher-priced items. Shape:

```ts
rankBy?: { text?: number; fields?: { field: string; weight: number }[] }
```

The per-document ordering score is:

```text
score = (text ?? 1) * text_match + Σ ( weight * Number(stored[field] || 0) )
```

A missing or non-numeric field contributes `0`. `text` defaults to `1`, so
`rankBy: { fields: [{ field: "popularity", weight: 0.1 }] }` adds `0.1 ×
popularity` to each document's relevance score for ordering purposes. The
reported `text_match` is **unchanged** — `rankBy` only reorders.

## Multi-key sort (`sortBy`)

`sortBy` replaces the default relevance ordering with an explicit list of sort
keys, applied lexicographically (first key primary, then ties broken by the
next, and so on). Shape:

```ts
sortBy?: { field: string; order: "asc" | "desc" }[]
```

- `field` is either `"_text_match"` (the ordering score, which honors `rankBy`
  if present) or any numeric stored field (coerced with `Number(...)`; missing
  or non-numeric → `0`).
- `order` is `"asc"` or `"desc"`.
- The final tie-break is always document `id` ascending, for deterministic
  output.
- With no `sortBy`, the default is relevance score descending
  (`[{ field: "_text_match", order: "desc" }]`).

Example — primary by price ascending, then by relevance descending:

```ts
sortBy: [
  { field: "price", order: "asc" },
  { field: "_text_match", order: "desc" },
]
```

> **`text_match` is always the RAW relevance score** (exact > prefix > typo).
> `rankBy` and `sortBy` affect result **ordering only**; they never change the
> `text_match` value reported on each hit.

## Filtering (`filter_by`)

Pass `filterBy` to constrain the matched + filtered result set. The expression
is evaluated against each document's **stored** fields, and every field
referenced must be declared in the collection's `filterFields`.

Supported clause forms (where `field` is a declared filter field):

| Form | Meaning |
| --- | --- |
| `field:value` | exact match (string equality, or numeric equality for `number` fields) |
| `field:[a,b,c]` | in-set — matches any of the listed values |
| `field:>n`, `field:>=n`, `field:<n`, `field:<=n` | numeric comparator (numeric fields only) |
| `field:[lo..hi]` | numeric range, inclusive on both ends (numeric fields only) |

Clauses combine with `&&` (AND) and `||` (OR), and may be grouped with
parentheses. `&&` binds tighter than `||`, so `a:1 && b:2 || c:3` parses as
`(a:1 && b:2) || c:3`. Use parentheses to override.

Values containing spaces (or filter punctuation) must be **double-quoted**:
`brand:"Acme Corp"`. Comparators and ranges require a field declared as
`type: "number"`; using them on a string field — or passing a non-numeric
value where a number is expected — throws a parse error. Referencing a field
that is not declared in `filterFields` also throws.

Examples:

```text
category:Shoes
brand:[Aurora,Nimbus]
price:>50
price:[25..100]
category:Shoes && price:<100
brand:Aurora || brand:Nimbus
(brand:Aurora || brand:Nimbus) && price:<100
```

> Negation (`!=` / "not equal") is **not** supported yet.

## Faceting (`facet_counts`)

Pass `facetBy` with a list of declared `facetFields` to receive `facet_counts`
in the result. Counts are **query-scoped**: they are computed over the current
result set *after* full-text matching and `filterBy` have been applied — not
over the whole collection. Each requested field yields one `FacetCount` entry
(`{ field_name, counts }`); within it, distinct stored values are counted,
sorted by **count descending** (ties broken by **value ascending**), and capped
at `maxFacetValues` (default `10`). Documents whose facet field is missing or
`null` are skipped. Values are compared as strings.

## Behavior & semantics

- **Tokenization** — text is lowercased and split on any non-(Unicode
  letter/number) character. There are **no stopwords** and **no stemming**;
  tokens match exactly. (`"Red-Shoe!"` → `["red", "shoe"]`.)
- **Multi-word queries are AND** — every query token must be present for a
  document to match (`"red shoe"` matches only documents containing both `red`
  and `shoe`).
- **Prefix matching on the last token** — the final token of a query also
  matches any indexed term it is a prefix of (so a partial word the user is
  still typing matches longer terms). Earlier tokens must match in full (exact
  or typo). A prefix match scores below an exact match.
- **Typo tolerance** — a token can match an indexed term within a bounded
  Levenshtein edit distance. Candidate terms are gathered from a trigram index
  and then distance-checked. The allowed typo budget scales with token length:
  tokens of length ≤ 3 tolerate **0** typos (must match exactly), 4–7 tolerate
  **1**, and ≥ 8 tolerate **2**. A typo match scores below exact and prefix, and
  lower the farther the edit distance.
- **Relevance ranking** — each hit carries a `text_match` score. Per token, an
  exact match scores `3`, a prefix match `2`, and a typo match `2 − 0.5 × distance`
  (so distance-1 → `1.5`, distance-2 → `1.0`); a document's `text_match` is the
  sum of its best per-token scores. Results are sorted by `text_match`
  descending, with ties broken by document `id` ascending.
- **Highlighting marks matched words in searched fields** — the marked fields
  are the `queryBy` subset when provided, otherwise all `searchFields`; only
  fields whose stored value is a string are highlighted.
- **`rankBy`/`sortBy` reorder, never rescore** — the reported `text_match` is
  always the raw relevance score; `rankBy` and `sortBy` only change the order in
  which hits are returned.
- **`queryBy`** — when provided, a document only matches a token if that token
  appears in one of the listed fields.
- **Empty query = match-all** — useful for "browse all" / initial listings,
  returned paginated and sorted by document `id` (with `text_match` `0`).
- **`storedFields` is the projection** — `hits[].document` contains exactly the
  fields configured by `storedFields` (`"all"` or the explicit list).
- **Synchronous writes** — once an `upsert`/`upsertMany`/`delete` mutation
  commits, the change is reflected in subsequent searches. No indexing lag.
- **Replace-by-id** — upsert identity is the consumer-provided string `id`;
  re-upserting an `id` fully replaces the previous document.

## Roadmap & limitations

The following are **not** implemented yet and are documented honestly so you can
decide whether this release fits your use case:

- **Highlighting is full-field-value only.** The `snippet` highlights the
  entire field value; there is no windowed/truncated snippet around the match.
  The `<mark>` tag is fixed and not configurable. Marking is per-term, not
  per-document provenance: any word in a searched field whose term matched the
  query is marked, even if a different document supplied the matching posting.
- **No negation in `filter_by`.** Exact, in-set, numeric comparator, and range
  clauses are supported, but `!=` / "not equal" is not yet.
- **Sort and rank are in-memory, bounded-scale.** `rankBy`/`sortBy` ordering
  (and faceting) are computed in-memory over the current result set; there is no
  write-maintained indexed sort/filter table.
- **Faceting is over scalar fields only, and in-memory.** Array-valued fields are
  not yet expanded into multiple facet values, and there is no write-maintained
  indexed filters table — filtering and faceting are evaluated in-memory over the
  current result set. Indexed, write-maintained filters/sort and array facets are
  a Phase 4 concern.
- **Correct within bounded scale only.** Read paths have been partially
  un-bounded (see "Lean reads" below), but two limits remain. Browse combined
  with filtering, faceting, or a custom sort/rank still loads the whole
  collection into memory to evaluate those in-memory (Phase 4 slices S2–S4 lift
  this). And a single query term matching more than ~16k postings exceeds
  Convex's per-query read limit (the "hot-term" problem). Within that ceiling
  (roughly tens of thousands of documents per collection) everything is
  **exact**; beyond it such a query will exceed limits.

### Lean reads (Phase 4 S1 — implemented)

The first Phase 4 slice replaces the unconditional full-collection scan with an
[`@convex-dev/aggregate`](https://www.npmjs.com/package/@convex-dev/aggregate)
counter maintained on every write:

- **`out_of` is an O(log n) aggregate count** — no full-collection scan to report
  the collection size.
- **Text queries load only the matched documents.** A query with search terms
  builds its candidate set from the `postings` index and hydrates only those
  documents — never the whole collection.
- **Simple browse pages directly off the aggregate.** An empty query with no
  filter, no facets, and no custom sort/rank reads the page's document ids
  straight from the ordered aggregate (`at(offset)`), then loads just that page.
- **Browse + filter/facet/custom-sort still loads the full collection.** When an
  empty-query browse is combined with filtering, faceting, or a custom
  `sortBy`/`rankBy`, the collection is still loaded in memory to evaluate them.
  Indexed filters, sharded facet counters, and an indexed numeric sort are the
  remaining Phase 4 slices (S2–S4).
- **Still candidate-based for weighted ranking.** `rankBy` weighted ordering
  remains computed in-memory over the candidate/result set; hot terms and exact
  query-scoped facet counts at very large scale are still bounded as described
  above.

### Scaling beyond the bounded limit (Phase 4 — designed, not yet built)

The bounded-scale ceiling is **not a permanent wall** — it is a deliberate
stopping point. The component is intentionally exact-and-simple for the common
case, and a documented **Phase 4** lifts it to arbitrary (millions-of-docs)
scale when a real workload needs it. It is decomposed into independently
buildable pieces (see
[the Phase 4 design spec](./docs/superpowers/specs/2026-06-13-typesense-convex-phase4-design.md)):

- **Indexed retrieval** — replace the per-query full-collection load with a
  sharded `out_of` counter, an ordered document index for browse/paging, a
  write-maintained `filters` table, precomputed sharded facet counters, and an
  indexed numeric sort. This is the core scale unlock.
- **Postings sharding + early termination** — bound hot-term postings reads.
- **Async bulk import** — stage and background-index large imports (today
  `upsertMany` runs in a single mutation and is bounded by per-mutation limits).
  This is the recommended first piece, and is independent of the others.
- **Array-valued facets/filters** — expand array fields (e.g. `tags`) into
  multiple facet/filter values.

**Fundamental tradeoff to expect at that scale:** exact query-scoped
`facet_counts` and exact `found` require counting the entire match set, which is
unbounded — so at very large scale they necessarily become **bounded estimates,
explicitly flagged in the response**, while staying exact below the threshold.
That tradeoff is why Phase 4 is opt-in rather than always-on: most collections
never need it and are better served by the exact model above.

### Migration: re-index after upgrading

Matching (including **exact** full-word matching) now depends on the `terms`
table, which is only populated on write. If you indexed documents under an
earlier version that did not maintain `terms`/`trigrams`, those documents will
return **zero results for every query — even exact ones — until you re-upsert
them**. After upgrading, re-run `upsert` (or your seed routine) for existing
documents so their `terms`/`trigrams` rows are built.

The Phase 4 S1 aggregate counter (`out_of`, lean browse) is likewise only
populated on write. Collections indexed before S1 will report `out_of: 0` (and
empty-browse will return nothing) until the counter is backfilled. You have two
options:

- **Re-upsert** existing documents (the same re-index step above also rebuilds
  the counter), or
- **Backfill the counter only**, without re-tokenizing, via
  `search.backfillCounterPage(ctx, { collection, cursor, batch })`. It processes
  one bounded page per call and returns `{ cursor, done }`; call it in a loop (or
  self-chain it with `ctx.scheduler`) until `done` is `true`. It is idempotent
  (`insertIfDoesNotExist`), so it is safe to re-run. See
  [`example/convex/products.ts`](./example/convex/products.ts) (`backfillCounter`)
  for a self-chaining driver.

## Running the example app

The repository includes [`example/`](./example), an ecommerce storefront demo
(React + Vite) backed by this component.

From the repo root, in one terminal start the Convex backend (this prompts you
to deploy and runs a watcher that rebuilds the component):

```sh
npm install
npm run dev
```

In a second terminal start the Vite frontend:

```sh
npm run dev:frontend
```

Open the app, click **Seed 6** to create the `products` collection and load
sample documents, then try searching (e.g. `aurora shoe`, `aur` for a prefix
match, or `aurra` to see typo tolerance in action).

### Stress-testing with a 5,000-product synthetic dataset

[`example/convex/dataset.ts`](./example/convex/dataset.ts) is a deterministic
generator producing 5,000 products with rich fields — `brand`, `category`,
`subcategory`, `price`, `rating`, `popularity`, `views`, `purchases`,
`releasedDaysAgo`, `inStock`, and a precomputed **`affinity`** score (each
product's match to a demo user profile of preferred categories/brands, past
search terms, and viewed items). `affinity` is what makes the weighted sort
*personalized*: `rankBy: { text: 1, fields: [{ field: "affinity", weight: 5 }] }`
ranks results by relevance blended with how well they fit the user.

Load it from the storefront's **Load 5k** button (it seeds in the background via
a self-chaining mutation, so the result count climbs live), or from the CLI:

```sh
npx convex run products:startSeed '{"total":5000}'   # background load
npx convex run products:benchmark '{}'               # feature + timing sweep
```

`benchmark` runs a representative query set (plain/AND/prefix/typo/filter/facet/
personalized-sort/multi-key-sort/deep-pagination) and reports `found` +
`search_time_ms` for each. 5,000 docs sits comfortably under the per-query read
ceiling, so this exercises real speed within the exact-correct envelope.

> **Note (a real scale finding):** `deleteCollection` reads every index row in a
> single mutation, so it hits Convex's 4,096-reads-per-call limit on a large
> collection. The loader avoids this by re-seeding (upsert replaces) rather than
> dropping. A batched, scalable `deleteCollection` is part of Phase 4.

## Design specs

The multi-phase design is documented in
[`docs/superpowers/specs/`](./docs/superpowers/specs/):

- [Phase 1 — exact tokenized search](./docs/superpowers/specs/2026-06-13-typesense-convex-phase1-design.md)
- [Phase 2 — filtering & faceting](./docs/superpowers/specs/2026-06-13-typesense-convex-phase2-design.md)
- [Phase 3 — typo tolerance, weighted ranking & highlighting](./docs/superpowers/specs/2026-06-13-typesense-convex-phase3-design.md)
- [Phase 4 — arbitrary-scale hardening](./docs/superpowers/specs/2026-06-13-typesense-convex-phase4-design.md)
