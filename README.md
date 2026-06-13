# Convex Typesense Search

[![npm version](https://badge.fury.io/js/@elevatech%2Ftypesense-search.svg)](https://badge.fury.io/js/@elevatech%2Ftypesense-search)

A [Convex](https://convex.dev) component providing exact, tokenized full-text
search with [Typesense](https://typesense.org)-shaped results — entirely inside
your Convex deployment. No external search service to run, no sync pipeline to
maintain: writes are durable Convex mutations and become searchable
immediately.

> **Status: Phase 1.** This release delivers exact-match tokenized search with
> Typesense-shaped output. Typo tolerance, filtering/faceting, weighted ranking,
> highlighting, and large-scale hardening are planned for later phases — see
> [Roadmap & limitations](#phase-1-limitations) and the
> [design specs](#design-specs). Document and result shapes are designed to be
> forward-compatible with those phases.

Found a bug? Feature request?
[File it here](https://github.com/elevatech/typesense-search/issues).

## Features

- **Exact tokenized full-text search** — lowercase + Unicode alphanumeric
  tokenization, multi-word queries combined with AND semantics.
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
npm install @elevatech/typesense-search
```

Then register the component in your app's `convex/convex.config.ts`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import typesenseSearch from "@elevatech/typesense-search/convex.config";

const app = defineApp();
app.use(typesenseSearch);

export default app;
```

## Quick start

Construct a `TypesenseSearch` client with the installed component reference,
then call its methods from your own Convex functions.

```ts
import { components } from "./_generated/api";
import { TypesenseSearch } from "@elevatech/typesense-search";

const search = new TypesenseSearch(components.typesenseSearch);
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
      "highlight": {},    // always {} in Phase 1
      "text_match": 0     // always 0 in Phase 1
    }
  ],
  "facet_counts": []      // always [] in Phase 1
}
```

## API reference

All methods take the Convex `ctx` as their first argument. Mutating methods must
be called from a mutation (or action); read methods from a query (or action).

### `createCollection(ctx, { name, searchFields, storedFields? })`

Creates a collection. `searchFields` is the list of document fields that are
tokenized and indexed for matching. `storedFields` controls the projection
returned in hits — `"all"` (default behavior in the example) stores the whole
document, or pass a `string[]` to store only those fields. Call from a mutation.

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

### `search(ctx, { collection, q, page?, perPage?, queryBy? })`

Runs a search and returns a [`SearchResult`](#search-output-shape).

- `q` — the query string. Empty/whitespace-only `q` matches all documents
  (browse mode).
- `page` — 1-based page number. Defaults to `1`.
- `perPage` — page size. Defaults to `10`, capped at `250`.
- `queryBy` — optional `string[]` restricting which fields are allowed to match
  for this query (a subset of the collection's `searchFields`). Omit to match
  across all indexed fields.

Call from a query.

## Behavior & semantics

- **Tokenization** — text is lowercased and split on any non-(Unicode
  letter/number) character. There are **no stopwords** and **no stemming**;
  tokens match exactly. (`"Red-Shoe!"` → `["red", "shoe"]`.)
- **Multi-word queries are AND** — every query token must be present for a
  document to match (`"red shoe"` matches only documents containing both `red`
  and `shoe`).
- **Exact tokens only** — a query token must equal an indexed token. No prefix,
  fuzzy, or typo matching.
- **`queryBy`** — when provided, a document only matches a token if that token
  appears in one of the listed fields.
- **Empty query = match-all** — useful for "browse all" / initial listings,
  returned paginated and sorted by document `id`.
- **`storedFields` is the projection** — `hits[].document` contains exactly the
  fields configured by `storedFields` (`"all"` or the explicit list).
- **Synchronous writes** — once an `upsert`/`upsertMany`/`delete` mutation
  commits, the change is reflected in subsequent searches. No indexing lag.
- **Replace-by-id** — upsert identity is the consumer-provided string `id`;
  re-upserting an `id` fully replaces the previous document.

## Phase 1 limitations

This phase is intentionally scoped. The following are **not** implemented yet
and are documented honestly so you can decide whether Phase 1 fits your use case:

- **No typo tolerance / fuzzy / prefix matching.** Tokens match exactly.
- **No filtering.** There is no `filter_by`; you cannot constrain results by
  field value (planned for Phase 2).
- **`facet_counts` is always `[]`.** Faceting arrives in Phase 2.
- **`highlight` is always `{}`** and **`text_match` is always `0`.** Highlighting
  and relevance scoring/weighted ranking arrive in Phase 3. Results are currently
  ordered by document `id`, not by relevance.
- **Correct within bounded scale only.** A single query term that matches more
  than ~16k postings exceeds Convex's per-query read limit (the Phase 4
  "hot-term" problem). Within that ceiling, `found` and result exactness hold;
  beyond it the query will fail. Large-scale hardening is Phase 4.

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

Open the app, click **Seed data** to create the `products` collection and load
sample documents, then try searching (e.g. `aurora shoe`, `wool`, `bottle`).

## Design specs

The multi-phase design is documented in
[`docs/superpowers/specs/`](./docs/superpowers/specs/):

- [Phase 1 — exact tokenized search](./docs/superpowers/specs/2026-06-13-typesense-convex-phase1-design.md)
- [Phase 2 — filtering & faceting](./docs/superpowers/specs/2026-06-13-typesense-convex-phase2-design.md)
- [Phase 3 — typo tolerance, weighted ranking & highlighting](./docs/superpowers/specs/2026-06-13-typesense-convex-phase3-design.md)
- [Phase 4 — arbitrary-scale hardening](./docs/superpowers/specs/2026-06-13-typesense-convex-phase4-design.md)
