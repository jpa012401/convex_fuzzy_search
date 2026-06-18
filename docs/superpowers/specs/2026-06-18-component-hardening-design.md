# FuzzySearch Component Hardening — Design

**Date:** 2026-06-18
**Status:** Approved
**Branch:** `improve/component-hardening`

## Goal

Four targeted improvements to the FuzzySearch component surfaced by a
function-by-function review. One performance fix, one semantics-hardening
batch, two cleanups. **No public API behavior changes.** All 207 existing tests
must stay green; new tests are added for the semantics items.

Out of scope (deliberately): the sparse posting-chunk optimization
([postingChunks.ts](../../../src/component/postingChunks.ts) TODO), the rank-browse
pagination "duplicate" finding (investigated and retracted — not a bug), and the
`applyCollectionConfig` deletion guard (already fixed and merged to `main`).

## Items

### #1 — Batched pagination (performance)

**Problem.** `pageDocIds` ([counters.ts:46](../../../src/component/counters.ts#L46)) and
`pageSortedDocIds` ([sortIndex.ts:81](../../../src/component/sortIndex.ts#L81)) page a result
window with a `count()` followed by up to `perPage` (≤250) **sequentially
awaited** `at(offset+i)` aggregate lookups — up to 251 round-trips per browse or
sort query, on the hot read path.

**Fix.** Replace the `at()` loop with a single **`atBatch`** call. The
`@convex-dev/aggregate` client exposes
`atBatch(ctx, queries: NamespacedOptsBatch<{ offset; bounds? }>): Promise<Item[]>`
— the batch form of `at()`. It returns the items at a list of offsets in one
call, producing output **provably identical** to the current loop (same offsets,
same key order), so existing pagination tests cover correctness.

Both functions become:

```ts
const total = await agg.count(ctx, { namespace });
const offsets = [];
for (let i = 0; i < limit && offset + i < total; i++) offsets.push(offset + i);
if (offsets.length === 0) return [];
const items = await agg.atBatch(
  ctx,
  offsets.map((o) => ({ offset: o, namespace })),
);
return items.map((it) => it.id);
```

(`pageSortedDocIds` uses its tuple namespace; otherwise identical.)

**Why `atBatch` over the alternatives.** `Promise.all(at)` still issues N
separate server calls; `iter`+skip pays an internal skip-read cost for deep
pages and needs offset-seeking logic. `atBatch` is the library's intended
offset-batch primitive: one call, no skip cost, no new control flow.
`pageSortedDocIdsRange` ([sortIndex.ts:101](../../../src/component/sortIndex.ts#L101)) keeps its
`iter` form (it wants a contiguous prefix, not arbitrary offsets) and is
unchanged. `iter`/`paginate` remain the documented escape hatch if cursor-style
pagination is ever wanted.

**Risk.** Low — internal-only, no signature change, covered by existing
`search.test.ts` / `sort-search.test.ts` browse/sort pagination cases. If
`atBatch`'s empty-input or bounds behavior differs from expectation, the
existing tests fail loudly.

### #2 — Semantics: document + test (no behavior change)

Three load-bearing behaviors are correct but undocumented and untested. Add a
contract comment at each site plus a focused test. **No logic changes.**

1. **`numField` missing → 0** ([ranking.ts:4](../../../src/component/ranking.ts#L4),
   used by sort `encodeKey` and rank `evalTerms`). A doc missing a numeric sort
   field sorts *as if the value were 0* (interleaved with real zeros), not last.
   - Comment: state the missing-value contract at `numField`.
   - Test: two docs, one missing the sort field, one with value `0`, and one with
     a positive value; assert the missing-field doc orders alongside the `0` doc,
     not at the end.

2. **`found` is a floor under truncation** ([search.ts:218](../../../src/component/search.ts#L218)).
   When the driver scan truncates, `found` is the materialized-candidate count
   (a lower bound), corrected to the exact `terms.docCount` only for the
   single-exact-term / no-filter / no-queryBy case; `found_approximate` is `true`.
   - Comment: document that `found` is a floor whenever `found_approximate`.
   - Test: force truncation via a small `matchTokens` budget (the function already
     accepts a `budget` param) on a multi-token query; assert
     `found_approximate === true` and `found <= trueCount`.

3. **facet `String()` projection invariant** ([write.ts:65](../../../src/component/write.ts#L65)
   decrement vs [write.ts:136](../../../src/component/write.ts#L136) increment).
   `incrementFacet` stringifies the *raw input* value; `decrementFacet` (in
   `clearDoc`) stringifies the *projected stored* value. They net to zero only
   because every projection mode preserves facet-field values identically.
   - Comment: note the invariant at the decrement site in `clearDoc`.
   - Test: under an **explicit** `storedFields` projection that includes the facet
     field, upsert then delete a doc and assert the facet count returns to zero
     (row removed).

### #3 — Write-path `.collect()` bound

[write.ts `clearDoc`:45](../../../src/component/write.ts#L45) loads a doc's `filters` rows
with `.collect()`. The count equals the collection's `filterFields` length
(bounded by config), but it is the one unbounded-in-principle `.collect()` in the
write path.

**Fix.** Change to `.take(col.filterFields?.length ?? 0)`. `clearDoc` currently
receives `facetFields` and `sortSpecs` but not `filterFields`; thread
`filterFields` (or its length) in from the two callers (`upsertInternal`,
`deleteDoc`). Existing write/delete tests cover correctness.

### #4 — Cleanup

- [types.ts:19](../../../src/component/types.ts#L19): remove the stale
  `// empty in Phase 1` comment on `facet_counts` (facets are populated now).
- [http.ts](../../../src/component/http.ts): **keep the file** — it is referenced by
  generated `_generated/api.ts`, so removing it requires codegen. Replace the
  stale scaffold comment ("new search routes will be added in a later phase")
  with an accurate one noting the component currently exposes no HTTP routes.

## Sequencing & testing

One branch, `improve/component-hardening`, four commits — each independent and
revertible, ordered easiest-first:

1. **#4 cleanup** (comment-only) → `npm test`.
2. **#3 `.collect()` bound** → targeted write/delete tests, then `npm test`.
3. **#2 semantics** (comments + 3 new tests) → new tests, then `npm test`.
4. **#1 `atBatch`** (internal perf) → `search.test.ts` + `sort-search.test.ts`,
   then `npm test`.

Gate after every commit: `npm test` (vitest + typecheck) must be 207+ passing,
zero type errors. `npm run typecheck` (whole-project) once before opening the
merge.

## Success criteria

- All existing tests green; 3 new semantics tests added and passing.
- `pageDocIds` / `pageSortedDocIds` issue one `atBatch` call instead of a
  per-offset loop; pagination output unchanged.
- No `.collect()` without an explicit bound in the write path.
- No stale phase-reference comments remain in `types.ts` / `http.ts`.
- Public API (`search`, `upsert`, config mutations, returned shapes) unchanged.
