# Typesense-style Search Convex Component — Phase 1 Design

**Date:** 2026-06-13
**Status:** Approved (design); pending implementation plan
**Scope:** Phase 1 of a multi-phase project

## Goal

A publishable, reusable **Convex component** that provides Typesense-style
full-text search over documents stored in Convex, returning Typesense-shaped
output (`{ found, hits, facet_counts, ... }`). The component is the long-term
target for parity with Typesense search plus an Elasticsearch-style weighted
sort, but it is delivered in phases. **This document specifies Phase 1 only.**

### Why build it (not wrap Convex search)

Convex's native full-text search index has no typo tolerance and no fuzzy
matching, and is limited to single-field prefix search with no native faceting
or relevance-tuned weighted ranking. To match Typesense behavior we build a
custom inverted index and the faceting/ranking layers on top of Convex
primitives.

### Hard constraints that shape the design

- A single Convex query reads at most ~16k documents / 8MB. You cannot scan an
  unbounded match set or an unbounded postings list at query time.
- Exact, query-scoped `found` and `facet_counts` at arbitrary scale require
  counts to be precomputed/maintained incrementally; there is no scan-time
  shortcut. This is the central tension of the overall project.

Because of these constraints the full system is **too large for one spec** and
is decomposed into phases.

## Project Phasing (overall)

- **Phase 1 (this doc):** Core ingestion + tokenized inverted index + exact
  full-text search + exact `found` count + Typesense-shaped output. No typo
  tolerance, no faceting, no filtering, no ranking. Lives within bounded scale.
- **Phase 2:** Filtering (`filter_by`) + faceting (`facet_counts`).
- **Phase 3:** Typo tolerance (trigram index + edit distance) + weighted /
  relevance ranking (`text_match`) + highlighting.
- **Phase 4:** Scale hardening — sharded counters, postings sharding, early
  termination — the "arbitrary scale" push.

Each phase gets its own spec → plan → implementation cycle.

## Phase 1 Decisions (locked)

- **Use case:** reusable/open-source component (no control over consumer schema).
- **Matching engine:** fully custom inverted index (not Convex native search).
- **Returned-document storage:** configurable projection ("C") — consumer
  declares which fields to store-and-return; defaults to storing the whole
  document. Consumer can make the component the source of truth (zero
  duplication) or store only an id + display fields and join back.
- **Document identity:** consumer-provided string `id`, upsert semantics ("A").
- **Indexing trigger:** synchronous — indexing happens in the same mutation as
  the write, in one transaction. Immediately consistent.
- **Tokenization:** lowercase + Unicode alnum split; no stop words; no stemming.
- **Match semantics:** all query tokens must match (AND); exact tokens only
  (no prefix, no typo).

## Architecture

A Convex component with its own isolated schema and functions. The consuming app
installs it, registers one or more **collections**, pushes documents in via
mutations, and searches via a query. One component instance serves many
collections (everything is keyed by `collection`).

## Data Model

All tables are owned by the component.

```
collections
  name: string                    // logical collection, e.g. "products"
  searchFields: string[]          // which doc fields get tokenized
  storedFields: string[] | "all"  // projection to persist + return
  // index: by_name [name]

documents
  collection: string
  docId: string                   // consumer-provided id
  stored: any                     // projected fields (JSON) — what hits return
  // index: by_collection_doc [collection, docId]

postings
  collection: string
  term: string
  docId: string
  field: string                   // source field of the term (Phase 3 ranking)
  tf: number                      // term frequency in that field (Phase 3 ranking)
  // index: by_collection_term [collection, term]
  // index: by_collection_doc  [collection, docId]
```

**Inverted index model:** row-per-posting (one row per `(term, docId, field)`).
Chosen over an embedded-array-per-term model because writes are independent
inserts (no contention / OCC conflicts), storage scales linearly, and deletes
are index lookups. `field` and `tf` are written in Phase 1 but unused until
Phase 3, so ranking needs no migration. Phase 4 evolves this into bucketed /
sharded postings without changing the API or row shape.

## API Surface

Functions are namespaced by collection and called from the consumer's own Convex
functions via the component handle.

### Admin / setup
- `createCollection({ name, searchFields, storedFields? })` — mutation.
  `storedFields` defaults to `"all"`. Errors if `name` already exists.
- `deleteCollection({ name })` — mutation. Drops documents + postings.
- `getCollection({ name })` — query. Returns config.

### Write path (synchronous, one transaction)
- `upsert({ collection, id, doc })` — mutation:
  1. validate collection exists (`CollectionNotFound` if not),
  2. delete existing postings for `(collection, id)` if present,
  3. tokenize each `searchField` → write postings rows,
  4. write/replace the `documents` row with the projected `stored`.
- `delete({ collection, id })` — mutation. Removes the `documents` row and all
  its postings.
- `upsertMany({ collection, docs })` — mutation. Thin convenience that loops
  `upsert` with a bounded batch size. Bulk-import hardening is Phase 4.

### Search path
- `search({ collection, q, page?, perPage?, queryBy? })` — query.
  - `q`: raw query string, tokenized with the **same** tokenizer as indexing.
  - `queryBy`: optional subset of `searchFields` to restrict matching
    (Typesense `query_by`); defaults to all `searchFields`. Enforced via the
    `field` column on postings (real restriction, not faked).
  - `page` (1-based, default 1), `perPage` (default 10, clamped ≤ 250).
  - Empty/whitespace `q` → match-all (docs in stable order) for browsing.

## Search Data Flow (exact AND)

1. Tokenize `q` → query tokens. Empty → match-all branch.
2. For each token, read `postings` by `[collection, term]` (filtered to
   `queryBy` fields) → a set of `docId`s.
3. Intersect the per-token sets → AND match set; `found` = its size.
4. Sort deterministically (Phase 1: stable order by `docId`), slice to
   `page`/`perPage`.
5. Load those `documents` rows → assemble `hits` from `stored`.

## Output Shape (Typesense-shaped)

The envelope is the final Typesense shape from day one. Later phases fill in
`facet_counts`, `highlight`, and `text_match` rather than changing structure.

```jsonc
{
  "found": 1234,            // total matching docs (exact in Phase 1, within ceiling)
  "page": 1,
  "out_of": 50000,          // total docs in collection
  "search_time_ms": 3,
  "hits": [
    {
      "document": { /* the `stored` projection */ },
      "highlight": {},      // empty in Phase 1; Phase 3
      "text_match": 0       // 0 placeholder in Phase 1; real score in Phase 3
    }
  ],
  "facet_counts": []        // empty in Phase 1; Phase 2
}
```

## Error Handling

- `upsert` / `search` / `delete` on a non-existent collection → thrown
  `CollectionNotFound` (not silent empty results).
- `createCollection` with an existing name → error. Config changes are a
  separate `updateCollection`, out of Phase 1 scope.
- `upsert` with a `doc` missing all `searchFields` → allowed: the doc is stored
  but produces no postings (not matchable). Documented, not an error.
- `page` / `perPage` clamped to sane bounds (`perPage` ≤ 250, `page` ≥ 1).
- A single tokenizer pure function is reused by both indexing and search, so
  query and index can never disagree on tokenization.

## Phase 1 Known Limits (explicit, not hidden)

- A token matching more postings than the query read ceiling (~16k) is the
  Phase 4 hot-term problem; Phase 1 is correct within bounded scale.
- `found` is exact only within that ceiling.
- No typo tolerance, prefix, faceting, filtering, ranking, or highlighting —
  those are Phases 2–3 by design.

## Sample App — Simple Ecommerce Storefront

Ships in `example/` as both a live demo and a manual test harness. Standard
component-example stack: **React + Vite + Convex client**, installing this
component.

**Backend (example Convex app):**
- Installs the component, creates a `products` collection
  (`searchFields: ["name", "description", "brand", "category"]`,
  `storedFields: "all"`).
- A `seed` mutation populating a few hundred sample products (name, description,
  brand, category, price, image URL).
- Thin wrapper query/mutation functions delegating to the component's
  `search` / `upsert`.

**Frontend (storefront UI):**
- Search-as-you-type box driving the component's `search`.
- Product grid rendering `hits` (image, name, brand, price).
- Visible `found` count ("1,234 results") and pagination controls.
- **Facet sidebar (category/brand/price) and a sort control are present but
  disabled / "coming soon"** — placeholders so Phase 2 (faceting/filtering) and
  Phase 3 (ranking) wire in without a redesign.

**Phase 1 UI scope is deliberately partial:** no working facet filters, no
relevance sort, no typo tolerance — those light up in later phases. The demo
proves the Phase 1 contract end-to-end (ingest → exact AND search → Typesense
envelope → rendered results + count + pagination).

## Testing Strategy (TDD — tests first, `convex-test` + Vitest)

- **Tokenizer unit tests:** case-folding, Unicode alnum split, punctuation,
  empty/whitespace.
- **Write-path tests:** upsert creates correct postings; re-upsert replaces with
  no orphan postings; delete removes documents + all postings; `storedFields`
  projection persists only declared fields.
- **Search tests:** single-token match; multi-token AND; `queryBy` restriction;
  match-all on empty `q`; `found` correctness; pagination slicing; no-match →
  `found: 0`, empty `hits`.
- **Output-shape test:** result envelope matches the Typesense contract exactly
  (keys present, placeholder values correct).
- **Multi-collection isolation:** writes/searches in one collection never leak
  into another.
- **Sample-app smoke check:** seed the `products` collection, run the storefront,
  confirm search-as-you-type returns expected hits, the `found` count is correct,
  and pagination works end-to-end.
