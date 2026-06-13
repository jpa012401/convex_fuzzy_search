# Typesense-style Search Convex Component — Phase 4 Design

**Date:** 2026-06-13
**Status:** PROVISIONAL roadmap spec — to be re-reviewed/refined when Phase 3 is complete
**Scope:** Phase 4 — Scale hardening toward arbitrary (millions-of-docs) scale
**Depends on:** Phases 1–3

## Goal

Lift the bounded-scale ceilings of Phases 1–3 so the component works at millions
of documents, accepting well-defined approximations where exactness is
physically impossible under Convex's ~16k-doc / 8MB query read limit. This is
where the project's "arbitrary scale" requirement is actually delivered.

## The walls being addressed

1. **Hot-term postings** — common terms have millions of postings; a single
   query cannot read them all.
2. **Query-scoped counts** (`found`, `facet_counts`) — exact counts require
   scanning the full match set, which is unbounded.
3. **Write contention** — incrementing shared counters/arrays on every write
   causes OCC conflicts.
4. **Bulk import** — large imports overload synchronous per-doc indexing.

## Techniques

### 4.1 Postings sharding + early termination
Evolve Phase 1's row-per-posting into bucketed postings: `term → many shard rows`
(each a capped batch), read in priority order with **early termination** once
enough high-quality candidates are gathered. Yields **capped candidate sets** →
`found` becomes a **bounded-accurate estimate** for very high-frequency terms
(exact for normal terms). API/row shape stay compatible (designed for this in
Phase 1).

### 4.2 Sharded counters for `found` and facets
Maintain precomputed counters, updated incrementally in the write path and
**sharded** across N rows per key to avoid write contention (pattern of Convex's
aggregate/counter component):
- per-collection document count (`out_of`),
- per-`(field, value)` facet counters for global facet counts.

**Query-scoped facets at scale** remain the hardest case: global counters ignore
filters. Options (decide at phase start):
- (a) approximate facets from the capped candidate set + a "approximate" flag in
  output,
- (b) precomputed counters per common filter combination,
- (c) hybrid: exact when match set is small, approximate (flagged) when large.
Recommendation: (c), and **always surface approximation in the response** rather
than silently returning wrong counts.

### 4.3 Async / batched bulk import
Add an async ingestion path: stage raw docs fast, index via scheduled/batched
functions with backpressure. The synchronous path (Phases 1–3) remains for
low-latency single writes; bulk uses the async path. Introduces a bounded
eventual-consistency window for bulk only.

### 4.4 Re-index / migration tooling
Background re-index job (rebuild postings/trigrams/counters) for config changes
and shard rebalancing, runnable without downtime.

## Known Limits / Explicit Tradeoffs

- `found` and `facet_counts` may be **approximate (and flagged as such)** for
  very large match sets — this is fundamental, not a bug. Typesense avoids it
  only by holding everything in RAM.
- Early termination can affect deep pagination on huge result sets.

## Open Questions (resolve at phase start)

- Shard count tuning (static vs. adaptive) for postings and counters.
- Exact policy for query-scoped facet approximation (4.2 a/b/c).
- Whether to adopt Convex's existing aggregate component vs. hand-rolled sharded
  counters.
- Eventual-consistency contract for the async bulk path.

## Testing Strategy (TDD)

- Postings sharding: correctness vs. unsharded for normal terms; early
  termination behavior + `found` estimate bounds for hot terms.
- Sharded counters: concurrency stress (no lost updates, no OCC failures);
  `out_of` and global facet accuracy.
- Approximation flags present and correct when thresholds exceeded.
- Async bulk import: throughput, eventual-consistency window, no orphan
  postings after large imports.
- Large-dataset benchmark (seed millions) validating query latency targets.
