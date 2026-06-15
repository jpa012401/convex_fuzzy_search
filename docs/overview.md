# FuzzySearch — Overview

`@elevatech/fuzzy-search` is a full-text search component for [Convex](https://convex.dev).
It runs **entirely inside your Convex deployment** — every index is a plain Convex
table, query, or mutation. There is no external search service to run and no sync
pipeline to keep in step: a document is searchable the instant the `upsert`
mutation commits.

> **Independent, not affiliated.** This is a from-scratch implementation, not a
> client for (or fork of) Typesense or Elasticsearch. It borrows two of their
> *ideas*: a **Typesense-style result envelope** (`{ found, hits, facet_counts, … }`)
> and an **Elasticsearch-style weighted ranking** (a `field_value_factor`-like
> blend). Everything else is its own design.

For the practical "how do I use it" reference, see **[usage.md](./usage.md)**.

---

## What it does

| Capability | Summary |
| --- | --- |
| **Tokenized full-text search** | lowercase + Unicode-alphanumeric tokenization; multi-word queries are AND |
| **Prefix (search-as-you-type)** | the last query token matches any indexed term it prefixes |
| **Typo tolerance** | trigram candidates + bounded Levenshtein, budget by token length |
| **Relevance ranking** | `text_match` score (exact > prefix > typo), best-first |
| **Highlighting** | automatic `{ snippet, matched_tokens }` per matched field, `<mark>`-wrapped, HTML-escaped |
| **Filtering** | `filter_by` grammar: exact, in-set, numeric comparators/ranges, `&&`/`||`/parens |
| **Faceting** | `facet_counts` per declared facet field |
| **Weighted ranking** | `rankBy` — blend relevance with numeric fields (full-scan, exact) |
| **Multi-key sort** | `sortBy` over `_text_match` or numeric fields, indexed for browse |
| **Ranking profiles** | `rank` — configurable windowed re-rank (field/flag/setBoost/recency/geo/relevance terms), lean |
| **Collections** | named, with their own search fields + stored projection |

---

## How it works

### Ingestion

`upsert` tokenizes the configured `searchFields` and maintains, in one
transaction, every index the document participates in:

- **`postings`** — one row per (term, doc, field): the inverted index.
- **`terms`** — the distinct-term dictionary with a `docCount` (document
  frequency) per term, ref-counted on write.
- **`trigrams`** — gram → term, for fuzzy candidate lookup.
- **`documents`** — the stored projection returned in hits.
- **`filters`** — index rows for declared `filterFields` (string `by_str`,
  numeric `by_num`), enabling indexed `filter_by`.
- **`facetCounts`** — per `(field, value)` running counts for declared
  `facetFields`.
- **doc-count aggregate** (`@convex-dev/aggregate`) — O(log n) collection size
  and ordered browse paging.
- **sort index** (a second aggregate) — one composite-keyed entry per declared
  `sortSpec`, for indexed browse-by-sort and the ranking-profile window.

Everything is synchronous: there is no background indexer and no eventual
consistency.

### Querying

A `search` call picks the leanest path that satisfies the query:

- **Browse** (empty `q`, no filter/facets/order) → page ids straight off the
  doc-count aggregate; load only that page.
- **Browse + facets** → counts from the `facetCounts` counters; no scan.
- **Browse + declared `sortBy`** → page off the sort index.
- **Text** → driver-token intersection: the most selective token (smallest
  `docCount`) drives the AND, the rest are verified per-doc — so reads scale with
  the result size, not with how common a word is. The driver scan is budget-capped
  (hot-term bound); if exceeded, the result is flagged `found_approximate`.
- **Filtered** → `filter_by` resolves to a doc-id set through the `filters` index;
  only matching docs are loaded.
- **Ranking profile (`rank`)** → re-rank a bounded top-N window (see below).

### Scaling model

The hard constraint behind every design choice: **a Convex query reads ~4096
documents max.** So nothing that must scale is allowed to load the whole
collection:

- `out_of`, browse paging, facet counts, indexed filters, and indexed sort are
  all O(log n) / cardinality-bounded reads, maintained on write.
- Text matching is bounded by the result size via driver-token intersection;
  a single ultra-common term is capped and surfaces `found_approximate: true`.
- A **live weighted blend** (`rankBy`, or an arbitrary per-query ranking) has no
  fixed sort key, so re-ordering the *whole* list would require scoring every doc.
  The lean answer is **ranking profiles**: re-rank only a **top-N window** taken
  off a declared base sort (`reranked: true`), continuing in base order beyond the
  window (`reranked: false`). Head-only, but bounded and deep-paginatable.

### Migration

Indexes are populated **on write**. A collection indexed under an older version
needs its documents replayed through `upsert` to rebuild the index rows (the app pages its own copy; the component cannot rebuild from its own storage under `storedFields: "derived"`). See the [migration section of usage.md](./usage.md#migration--reindex).

---

## Known limits

- `filter_by` has no negation (`!=`) and no array-valued fields yet.
- Faceting/sorting are over scalar fields; array-valued facets are deferred.
- A live `rankBy` (or a ranking-profile re-rank) is **head-only** at scale —
  it re-orders a window, not the entire collection. Exact whole-list weighted
  sort means a full scan (fine up to ~tens of thousands of docs).
- `deleteCollection` and `upsertMany` run in a single mutation, bounded by
  per-mutation limits; for very large collections, re-seed (upsert replaces)
  rather than dropping.
- Semantic "match my profile/text" ranking would need embeddings + a vector
  index (Convex has native vector search) — a complementary subsystem, not part
  of this component.

---

## Source map

| Area | Files |
| --- | --- |
| Tokenize / match | `src/component/{tokenizer,matching,fuzzy,textSearch}.ts` |
| Write path | `src/component/write.ts` |
| Filtering | `src/component/filter.ts` |
| Facet counters | `src/component/facetCounts.ts` |
| Sort index | `src/component/sortIndex.ts` |
| Doc counter / lean browse | `src/component/counters.ts` |
| Ranking | `src/component/{ranking,score}.ts` |
| Highlighting | `src/component/highlight.ts` |
| Search entry | `src/component/search.ts` |
| Reindex (app-driven) | example `reindex` mutation + `upsert` replay |
| Index health | `src/component/stats.ts` |
| Client | `src/client/index.ts` |
| Example app | `example/` |

Design specs live in [`docs/superpowers/specs/`](./superpowers/specs/).
