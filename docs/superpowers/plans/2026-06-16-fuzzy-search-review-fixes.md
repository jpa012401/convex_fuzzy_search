# Fuzzy Search Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the validated review findings around deterministic queries, public API contracts, bounded Convex reads/writes, and scale regression coverage.

**Architecture:** Keep the component API stable except where determinism requires removing server-side timing from query results. Prefer bounded reads with `.take(n)`, async iteration, or write-maintained indexes; use scheduled internal continuations for multi-transaction cleanup and ingestion work. Add regression tests at the component layer with `convex-test`, plus one local deployment lifecycle verification through the example app.

**Tech Stack:** Convex component functions, TypeScript, `convex-test`, Vitest, local `npx convex dev`.

---

## File Structure

- Modify `src/component/types.ts` to remove `search_time_ms` from `SearchResult`.
- Modify `src/component/search.ts` to remove `Date.now()` from the public query and add return validators.
- Modify `src/component/collections.ts`, `src/component/write.ts`, `src/component/configSync.ts`, and `src/component/stats.ts` to add return validators and bounded cleanup/ingestion APIs.
- Modify `src/component/facetCounts.ts`, `src/component/filter.ts`, `src/component/matching.ts`, and possibly `src/component/textSearch.ts` to add read budgets or bounded top-N paths.
- Modify `src/client/index.ts` so `createCollection` accepts `storedFields?: "all" | "derived" | string[]`.
- Add or modify tests in `src/component/search.test.ts`, `src/component/collections.test.ts`, `src/component/write.test.ts`, `src/component/filter-resolve.test.ts`, `src/component/matching.test.ts`, `src/component/facetCounts.test.ts`, `src/client/setup.test.ts`, and example lifecycle tests as needed.

## Task 1: Remove Non-Deterministic Search Timing

**Files:**
- Modify: `src/component/types.ts`
- Modify: `src/component/search.ts`
- Modify: `src/component/search.test.ts`
- Modify: `example/convex/products.ts`

- [ ] **Step 1: Write deterministic output regression test**

In `src/component/search.test.ts`, add a test that runs the same query twice and compares the full result object:

```ts
it("returns deterministic output for identical search inputs", async () => {
  const t = await setup();
  const args = { collection: "products", q: "red", page: 1, perPage: 10 };
  const first = await t.query(api.search.search, args);
  const second = await t.query(api.search.search, args);
  expect(second).toEqual(first);
  expect("search_time_ms" in first).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/component/search.test.ts`

Expected: FAIL because `search_time_ms` is present and computed with `Date.now()` in the query.

- [ ] **Step 3: Remove timing from the result contract**

In `src/component/types.ts`, remove `search_time_ms` from `SearchResult`.

In `src/component/search.ts`, remove `const start = Date.now();` and remove every `search_time_ms: Date.now() - start` property from return objects.

In `example/convex/products.ts`, update `benchmark` to measure around `ctx.runQuery` in the action:

```ts
const start = Date.now();
const r: any = await ctx.runQuery(api.products.searchProducts, c.args as any);
out.push({
  label: c.label,
  found: r.found,
  ms: Date.now() - start,
  top: r.hits[0]?.document?.name,
});
```

- [ ] **Step 4: Run deterministic test**

Run: `npm test -- src/component/search.test.ts`

Expected: PASS.

## Task 2: Add Public Returns Validators

**Files:**
- Modify: `src/component/search.ts`
- Modify: `src/component/collections.ts`
- Modify: `src/component/write.ts`
- Modify: `src/component/configSync.ts`
- Modify: `src/component/stats.ts`
- Modify: `src/component/schema.ts` if shared validators are useful

- [ ] **Step 1: Write metadata assertion for public return validators**

Add a component test that imports public function references and asserts the function spec exposes non-null returns once codegen has run. If this is awkward in `convex-test`, use a scriptable verification command in the implementation notes:

Run: `npx convex function-spec --deployment local --component fuzzySearch`

Expected after implementation: each public component query/mutation has a concrete `returns` object, not `null`.

- [ ] **Step 2: Add reusable validators**

Create shared validators for:

```ts
const hitValidator = v.object({
  id: v.string(),
  score: v.number(),
  highlight: v.record(
    v.string(),
    v.object({ snippet: v.string(), matched_tokens: v.array(v.string()) }),
  ),
});

const facetCountValidator = v.object({
  field_name: v.string(),
  counts: v.array(v.object({ value: v.string(), count: v.number() })),
});
```

Use them in `search.returns`.

- [ ] **Step 3: Add returns to each public API**

Use `returns: v.null()` for mutations that intentionally return no value:

```ts
export const createCollection = mutation({
  args: { /* existing */ },
  returns: v.null(),
  handler: async (ctx, args) => {
    // existing logic
    return null;
  },
});
```

Add explicit object/union returns for `getCollection`, `search`, `applyCollectionConfig`, and `stats`.

- [ ] **Step 4: Run verification**

Run: `npm run build:codegen && npm test && npx convex function-spec --deployment local --component fuzzySearch`

Expected: tests pass, typecheck passes, component public functions show non-null return specs.

## Task 3: Make Collection Deletion Batched

**Files:**
- Modify: `src/component/collections.ts`
- Modify: `src/component/facetCounts.ts`
- Modify: `src/component/sortIndex.ts`
- Modify: `src/component/collections.test.ts`

- [ ] **Step 1: Write cleanup continuation test**

Add a test with more rows than one cleanup batch and assert repeated calls or scheduled continuations remove all rows while preserving unrelated collections.

Expected behavior:

```ts
await t.mutation(api.collections.deleteCollection, { name: "products" });
expect(await t.query(api.collections.getCollection, { name: "products" })).toBeNull();
```

Then inspect component tables and assert zero rows for `products`.

- [ ] **Step 2: Implement internal batched cleanup**

Use an internal mutation with args `{ name: v.string(), batchSize: v.optional(v.number()) }`. Each invocation should `.take(batchSize)` from one table/index, delete those rows, and schedule itself with `internal.collections.cleanupCollectionBatch` until every table and aggregate namespace is clear.

Use `internal`, not `api`, for scheduled continuations.

- [ ] **Step 3: Keep public `deleteCollection` bounded**

Public `deleteCollection` should mark or delete the collection row and schedule cleanup; it must not `.collect()` every index table.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/component/collections.test.ts src/component/facets-write.test.ts src/component/filters-write.test.ts src/component/sort-write.test.ts src/component/counters-write.test.ts`

Expected: cleanup tests pass without unbounded reads.

## Task 4: Bound Candidate Discovery and Filter Result Expansion

**Files:**
- Modify: `src/component/matching.ts`
- Modify: `src/component/textSearch.ts`
- Modify: `src/component/filter.ts`
- Modify: `src/component/search.ts`
- Modify: `src/component/matching.test.ts`
- Modify: `src/component/filter-resolve.test.ts`

- [ ] **Step 1: Add hot prefix and trigram tests**

Create many terms sharing a prefix/trigram and assert candidate lookup stops at a configured budget and reports approximate/truncated behavior through search.

- [ ] **Step 2: Replace prefix `.collect()` with async iteration budget**

In `candidateTermsForToken`, stream prefix rows:

```ts
let prefixRead = 0;
for await (const r of prefixQuery) {
  if (prefixRead >= TERM_CANDIDATE_BUDGET) break;
  prefixRead++;
  setBest(r.term, PREFIX, r.docCount);
}
```

- [ ] **Step 3: Replace trigram `.collect()` with bounded reads**

Apply the same pattern per gram, with an overall fuzzy candidate read budget to prevent common trigrams from exceeding query limits before postings budgets apply.

- [ ] **Step 4: Add filter read budgets**

Update filter resolver helpers to use `.take(n)` or async iteration with an explicit cap for broad `str`, `num`, range, and `inSet` reads. Return `{ ids, truncated }` instead of just a `Set`, and propagate `found_approximate`.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- src/component/matching.test.ts src/component/filter-resolve.test.ts src/component/search.test.ts`

Expected: hot prefix/trigram and broad filter tests pass; existing search semantics remain unchanged for small fixtures.

## Task 5: Avoid Full Collection Loads Before Pagination

**Files:**
- Modify: `src/component/search.ts`
- Modify: `src/component/sortIndex.ts`
- Modify: `src/component/search.test.ts`
- Modify: `src/component/sort-search.test.ts`

- [ ] **Step 1: Add broad browse/custom-order tests**

Test empty-query browse with facets, rankBy, undeclared sortBy, and deep pagination against enough docs to catch page-after-full-load behavior.

- [ ] **Step 2: Keep indexed sort/rank paths windowed**

For declared sort specs, continue using `pageSortedDocIds` and `pageSortedDocIdsRange`.

For unsupported custom ordering, either:

1. reject the request with a clear error requiring a declared `sortSpec`, or
2. document and enforce a hard `MAX_CUSTOM_ORDER_WINDOW` with approximate results.

Prefer option 1 for stable component behavior.

- [ ] **Step 3: Bound filtered browse pagination**

When `filterBy` produces a large set, page doc loading to the requested page window instead of loading every matching doc before slicing. Preserve exact `found` only when the filter resolver did not truncate.

- [ ] **Step 4: Run search regression tests**

Run: `npm test -- src/component/search.test.ts src/component/sort-search.test.ts src/component/rank-search.test.ts`

Expected: small fixtures keep current ordering, broad paths are rejected or bounded.

## Task 6: Bound Facet Top-N and Stats Reads

**Files:**
- Modify: `src/component/facetCounts.ts`
- Modify: `src/component/stats.ts`
- Modify: `src/component/facetCounts.test.ts`

- [ ] **Step 1: Add high-cardinality facet test**

Create more facet values than the read budget and assert the helper returns a bounded top-N result or an explicit approximate/truncated marker.

- [ ] **Step 2: Choose the facet strategy**

For exact global top-N at scale, maintain an ordered aggregate per `(collection, field)` value. If that is too large for this release, enforce and document `MAX_FACET_CARDINALITY_READS` and mark results approximate when truncated.

- [ ] **Step 3: Bound `stats`**

Avoid `.collect()` of every facet value in `stats`. Either expose bounded stats with an approximate flag or maintain summary counters for distinct values and totals.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/component/facetCounts.test.ts src/component/search.test.ts`

Expected: facet helpers remain sorted by count desc/value asc and no longer require unbounded reads.

## Task 7: Bound Bulk Upserts

**Files:**
- Modify: `src/component/write.ts`
- Modify: `src/component/write.test.ts`
- Modify: `src/client/index.ts`
- Possibly add: `src/component/ingest.ts`

- [ ] **Step 1: Add max batch test**

Add a test that calls `upsertMany` with `MAX_UPSERT_MANY_BATCH + 1` docs and expects a clear error.

- [ ] **Step 2: Add guard**

```ts
const MAX_UPSERT_MANY_BATCH = 50;
if (args.docs.length > MAX_UPSERT_MANY_BATCH) {
  throw new Error(`upsertMany accepts at most ${MAX_UPSERT_MANY_BATCH} documents per call`);
}
```

- [ ] **Step 3: Document scheduled ingestion path**

If app-facing batch ingestion is needed, add a scheduled internal continuation that accepts cursor/app-owned source rows instead of accepting an unbounded array.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/component/write.test.ts example/convex/places.test.ts example/convex/placesData.test.ts`

Expected: small batches pass; oversized batches fail fast.

## Task 8: Fix Client `storedFields` Type

**Files:**
- Modify: `src/client/index.ts`
- Modify: `src/client/setup.test.ts`

- [ ] **Step 1: Add type coverage**

Add a compile-time test or usage sample that calls:

```ts
await search.createCollection(ctx, {
  name: "products",
  searchFields: ["name"],
  storedFields: "derived",
});
```

- [ ] **Step 2: Update method type**

Change:

```ts
storedFields?: "all" | string[];
```

to:

```ts
storedFields?: "all" | "derived" | string[];
```

- [ ] **Step 3: Run type tests**

Run: `npm run typecheck && npm test -- src/client/setup.test.ts`

Expected: `storedFields: "derived"` is accepted by the client wrapper.

## Task 9: Full Verification

**Files:**
- All modified files

- [ ] **Step 1: Run build and unit suite**

Run: `npm run build:codegen && npm test && npm run lint && npm run typecheck`

Expected: all commands exit 0.

- [ ] **Step 2: Reset local deployment**

Run local dev first:

```bash
npx convex dev --typecheck disable --codegen enable --tail-logs disable
```

Reset app and component data:

```bash
printf '[]' > .tmp-empty-import.json
npx convex import --deployment local --replace-all --yes --format jsonArray --table profiles .tmp-empty-import.json
npx convex import --deployment local --component fuzzySearch --replace-all --yes --format jsonArray --table collections .tmp-empty-import.json
rm .tmp-empty-import.json
```

Expected: import summary deletes all rows from app tables, component tables, and aggregate subcomponent tables.

- [ ] **Step 3: Run local lifecycle**

Run:

```bash
npx convex run --deployment local products.js:seed '{}'
npx convex run --deployment local products.js:searchProducts '{"q":"shoe","facetBy":["brand"],"perPage":3}'
npx convex run --deployment local products.js:indexStats '{}'
npx convex run --deployment local products.js:seed '{}'
npx convex run --deployment local products.js:searchProducts '{"q":"","sortBy":[{"field":"price","order":"asc"}],"perPage":3}'
npx convex run --deployment local places.js:seedPlaces '{"total":120}'
npx convex run --deployment local places.js:placeStats '{}'
npx convex run --deployment local products.js:benchmark '{}'
```

Expected: products seed returns `{ "seeded": 6 }`, search finds shoe hits, stats show `out_of: 6`, reseed does not leave duplicates, places stats show `out_of: 120`, and benchmark returns all cases without errors.

## Self-Review

- Spec coverage: Every reported P1/P2 item maps to a task above.
- Placeholder scan: No task contains deferred "TODO" work without a concrete verification command.
- Type consistency: Shared terms use existing names: `SearchResult`, `FacetCount`, `deleteCollection`, `upsertMany`, `storedFields`, and `rankProfiles`.
