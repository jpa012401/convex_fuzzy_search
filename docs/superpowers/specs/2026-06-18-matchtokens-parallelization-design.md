# matchTokens Verify-Loop Parallelization — Design

**Date:** 2026-06-18
**Status:** Approved
**Branch:** `perf/matchtokens-parallel`

## Goal

Cut text-search query latency by parallelizing the one genuinely-sequential
read loop in the search path — the `matchTokens` verify loop — with **zero
behavior change**. Confirm the speedup with a before/after benchmark on the
cloud dev deployment.

## Problem (evidence)

A 5k-document cloud benchmark (the `products:benchmark` action on deployment
`perfect-lion-433`) showed text queries are the slow cases:

| case | found | server ms |
|------|------:|----------:|
| multi-term AND | 40 | 892 |
| plain term | 159 | 800 |
| prefix (as-you-type) | 159 | 781 |
| typo tolerance | 159 | 707 |
| browse all | 5000 | 56 |
| category facet (browse) | 5000 | 125 |
| deep pagination (page 40) | 5000 | 134 |
| numeric range filter | 995 | 147 |

Browse/sort/pagination are fast (56–360ms) because they use already-parallel
reads (`Promise.all` in `loadDocs`, `atBatch` in pagination). Text queries are
slow because of the verify loop in
[`matchTokens`](../../../src/component/textSearch.ts) (lines 96–117), which is a
`for…of` loop with `await` inside — **strictly sequential**.

Static read-count analysis (deterministic, deployment-independent): for a driver
match count **D** and **P** docs that pass verification, the loop issues:
- **D** sequential `loadDocTerms(docKey)` reads (multi-token queries only;
  skipped when there are no non-driver tokens), then
- **P** sequential `loadDocumentByDocKey(docKey)` reads (only for passing docs,
  via the current early-exit).

→ up to **2D sequential** round-trips. `multi-term AND` matches ~159 driver docs
to yield 40 results → ~318 serial reads → 892ms. Each serial read is a network
round-trip on cloud; local masks it. This is the same pathology the `atBatch`
pagination fix already removed from the browse paths.

## Change

Restructure the single sequential loop into two parallel phases, preserving the
exact read set. Pseudocode (final code in the plan):

**Phase A — gather + verify.** When `others.length > 0` (the query has
non-driver tokens), `Promise.all` the `loadDocTerms(docKey)` reads for every
driver docKey. Then, purely in memory, build each doc's `present` map, blended
`total`, and `ok` flag using the existing `bestScore` logic. When
`others.length === 0` (single-token query), skip Phase A entirely — every driver
doc passes with `total = dScore`, exactly as today.

**Phase B — resolve docIds.** `Promise.all` the `loadDocumentByDocKey(docKey)`
reads, but **only** for docKeys that passed verification. Build `scoreById`
from the results, iterating the passing docKeys in `driverScore` order so the
map's insertion order is unchanged.

## Why zero behavior change

- **Identical read set.** Today every driver docKey gets a `loadDocTerms` read
  (multi-token) and only passing docs get a `loadDocumentByDocKey` read. Phase A
  reproduces the former; Phase B reproduces the latter (resolve only passing
  docKeys). Total reads = D + P, unchanged → the 4096-reads-per-query budget
  exposure is **identical**, so no new truncation risk.
- **Identical results and ordering.** `scoreById` is a `Map`; its insertion
  order follows `driverScore` iteration order in both the old and new code
  (Phase B preserves the passing docKeys' relative order). Scores come from the
  same `bestScore`/blend computation. `truncated`, `matchedTerms`, and
  `singleExactTerm` are computed before the loop and are untouched.
- **No signature change.** `matchTokens` keeps its exact parameters and return
  type; `search.ts` is not modified.

## Testing

Behavior-preservation is provable by the existing suite, which pins the
properties that could break:
- `textSearch.test.ts`, `search.test.ts`, `matching.test.ts`, `fuzzy.test.ts`
  must stay green (multi-token AND, prefix, typo, `queryBy` field restriction,
  truncation).
- **New focused test** in `textSearch.test.ts`: a multi-token query where some
  driver-matched docs fail the non-driver-token check. Assert (a) the failing
  docs are absent from results, and (b) `found` equals the passing count. This
  pins that Phase B resolves exactly the passing set (matching the old
  early-exit), the one place a parallelization bug could leak extra/missing docs.
- Full `npm test` = 211+ passing (210 + 1 new), 0 type errors.
- Whole-project `npm run typecheck` clean.

## Speedup verification (cloud, authorized)

The user authorized a deploy to the cloud dev deployment for measurement.

1. Before: capture `products:benchmark` output on cloud dev at HEAD (baseline —
   the numbers above).
2. Deploy the branch to cloud dev.
3. After: re-run `products:benchmark`; record the four text-case ms.
4. Success: the four text cases drop materially (target: roughly D-parallel, so
   into the low-hundreds-ms range), with **identical `found` and `top`** per
   case (proving no behavior change at scale). Record the before/after table in
   the plan's final step.

No production (`--prod`) deployment is touched; cloud dev only. No re-seed.

## Scope boundaries (explicitly out)

- The `boolean+facet` 2429ms case is **not** addressed — it is volume-bound
  (4000 already-parallel `loadDocs` reads); only bounding the facet-tally
  working set would help, and that exactness tradeoff was set aside.
- Text-path `loadDocs` re-read deduplication is **not** included (set aside).
- This is the single contained, zero-risk speedup; the larger semantic-changing
  fixes are deferred pending this measurement.

## Success criteria

- `matchTokens` verify loop issues its reads in two `Promise.all` batches, not a
  sequential loop; read count per query unchanged.
- All existing tests green + one new passing test; 0 type errors.
- Cloud-dev benchmark shows the four text cases materially faster with identical
  `found`/`top`.
- `matchTokens` signature and all returned shapes unchanged.
