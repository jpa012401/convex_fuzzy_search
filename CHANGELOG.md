# Changelog

All notable changes to `@elevatech/fuzzy-search` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Scale hardening (Phase 4) and configurable ranking. Read paths no longer load the
whole collection, and ranking is now declarative + lean.

### Added

- **Ranking profiles (`rankProfiles` + `rank`).** Declare named scoring profiles
  on a collection and apply them per query: a configurable windowed re-rank that
  softly re-orders a bounded top-N window off a declared base sort. Term types:
  `field`, `flag`, `setBoost`, `recencyDecay`, `geoDistance`, `relevance`. Per-query
  `context` (`now` / `origin` / `sets`) and `weights` overrides — nothing is
  materialized per user. See [docs/usage.md](./docs/usage.md#ranking-profiles).
- **`reranked: boolean`** on the result — `false` for a ranking-profile tail page
  (served in base order) or a capped candidate set.
- **`found_approximate: boolean`** on the result — `true` when a very common
  ("hot") query term causes the matched-set scan to be capped.
- **Indexed sort (`sortSpecs`).** Declare composite sort orders; unfiltered
  browse-by-sort pages off a sort index instead of loading the collection.
- **`stats(ctx, collection)`** — live index-health counts (doc count, per-facet
  totals, per-sort-spec entry counts) for validating a migration.
- **Backfill drivers** for migrating data indexed under an older version:
  `backfillCounterPage`, `backfillFiltersPage`, `backfillFacetCountsPage`,
  `backfillSortIndexPage` (each paginated + idempotent).
- **Docs:** [overview](./docs/overview.md) and [usage guide](./docs/usage.md).

### Changed

- **`filter_by` is now indexed.** Filtering resolves through a write-maintained
  `filters` index (no full-collection predicate scan). Browse+filter and
  text+filter load only matching documents.
- **Faceting is now counter-backed for browse.** Unfiltered browse facet counts
  come from write-maintained per-value counters; query-scoped facets (with a
  filter/text) remain exact over the matched set.
- **Lean reads.** `out_of` is an O(log n) aggregate count; simple browse pages
  off the aggregate; text queries load only matched documents.
- **Bounded text matching.** Multi-term queries drive the AND from the most
  selective token (reads scale with result size, not term frequency); a hot
  driver term is budget-capped and flagged via `found_approximate`.
- **Ordering precedence:** `rank` (a ranking profile) overrides `sortBy` and
  `rankBy` when more than one is supplied.
- `deleteCollection` now also clears the filter, facet-count, and sort indexes.

### Fixed

- Sort-index namespace aliasing for collection/field names containing the
  separator character (now a structured tuple namespace).
- Hot-term driver scan now streams with an early break so the budget actually
  bounds database reads (previously a `.collect()` read all postings first).
- Ranking-profile pagination gap when `window` was not a multiple of `perPage`
  (base documents between the window and the next page boundary were skipped).
- Ranking-profile facet counts now cover the full matched set, not the capped
  window.
- An unknown ranking-profile weight-override id (and an unknown profile) now
  throw instead of silently no-opping.
- `found` no longer uses a term's collection-wide document frequency when
  `queryBy` narrows the searched fields.

### Migration

Indexes are populated **on write**, so a collection indexed before this release
needs a one-time backfill (or a re-`upsert`) to use the new indexed filter,
facet, and sort paths — and to add `sortSpecs` / `rankProfiles`, the collection
must be (re)created with them. See
[Migration & backfills](./docs/usage.md#migration--backfills).

## [0.1.0]

Initial release — full-text search entirely inside Convex.

### Added

- Tokenized full-text search (lowercase + Unicode-alphanumeric; multi-word AND).
- Prefix matching on the last query token (search-as-you-type).
- Typo tolerance (trigram candidates + bounded Levenshtein; budget by token length).
- Relevance ranking via a raw `text_match` score (exact > prefix > typo).
- Automatic highlighting (`highlight[field] = { snippet, matched_tokens }`).
- Structured filtering (`filter_by`: exact, in-set, numeric comparators/ranges,
  `&&`/`||`/parentheses, quoted values).
- Faceting (`facet_counts` over declared facet fields).
- Weighted ranking (`rankBy`, Elasticsearch `field_value_factor`-style blend) and
  multi-key sort (`sortBy`) — ordering only; `text_match` stays raw.
- Field-scoped queries (`queryBy`), browse mode (empty query), and a
  Typesense-shaped result envelope (`{ found, page, out_of, search_time_ms, hits,
  facet_counts }`).
- Collections with configurable `searchFields` and `storedFields` projection;
  consumer-provided string `id` with replace-on-upsert; synchronous indexing.

[Unreleased]: https://github.com/elevatech/fuzzy-search/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/elevatech/fuzzy-search/releases/tag/v0.1.0
