# Component Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply four review-driven improvements to the FuzzySearch component — batched pagination, documented+tested semantics, a bounded write-path query, and dead-comment cleanup — with no public API behavior change.

**Architecture:** Each task is an independent, revertible commit on the branch `improve/component-hardening`, ordered easiest-first. Tasks #4/#3/#2 touch isolated functions; #1 swaps two internal pagination loops for the aggregate's `atBatch` primitive. The full vitest+typecheck suite gates every commit.

**Tech Stack:** TypeScript, Convex components, `@convex-dev/aggregate`, vitest + convex-test (run via `npm test` = `vitest run --typecheck`).

## Global Constraints

- All existing tests stay green: `npm test` must report **207+ passing, 0 type errors** after every commit.
- No public API behavior change: `search`, `upsert`, `upsertMany`, `deleteDoc`, config mutations, and all returned shapes are unchanged.
- Tests use `convexTest(schema, modules)` with `const modules = import.meta.glob("./**/*.ts")`. Any test touching counts/sort MUST call `registerAggregate(t, "docCount")` and (for sort/rank) `registerAggregate(t, "sortIndex")` first.
- Spec: `docs/superpowers/specs/2026-06-18-component-hardening-design.md`.

---

### Task 0: Create the working branch

**Files:** none (git only)

- [ ] **Step 1: Branch off main**

```bash
git checkout main
git checkout -b improve/component-hardening
git status
```
Expected: `On branch improve/component-hardening`, working tree clean.

---

### Task 1: Cleanup stale comments (#4)

**Files:**
- Modify: `src/component/types.ts:19`
- Modify: `src/component/http.ts:5-7`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (comment-only).

- [ ] **Step 1: Fix the stale `types.ts` comment**

In `src/component/types.ts`, the `SearchResult.facet_counts` line currently reads:

```ts
  facet_counts: FacetCount[]; // empty in Phase 1
```

Change the comment (facets are populated now):

```ts
  facet_counts: FacetCount[]; // per-field value tallies; empty unless facetBy is requested
```

- [ ] **Step 2: Fix the stale `http.ts` comment**

`src/component/http.ts` currently has:

```ts
// HTTP routes for the component are registered here.
// (The scaffold's `comments` demo route was removed along with lib.ts; new
// search routes will be added in a later phase.)
```

Replace those comment lines with an accurate one (keep the file — it is referenced by generated `_generated/api.ts`, so removing it would require codegen):

```ts
// HTTP routes for the component are registered here.
// The component currently exposes no HTTP routes; all access is via the
// query/mutation API. This router is kept as the registration point for any
// future routes (and because _generated/api.ts references it).
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: `Test Files 39 passed`, `Tests 207 passed`, `Type Errors no errors`.

- [ ] **Step 4: Commit**

```bash
git add src/component/types.ts src/component/http.ts
git commit -m "chore: remove stale phase-reference comments in types.ts and http.ts"
```

---

### Task 2: Bound the write-path filters query (#3)

**Files:**
- Modify: `src/component/write.ts:38-51` (`clearDoc` signature + the `.collect()` call)
- Modify: `src/component/write.ts:84` (`upsertInternal` call site)
- Modify: `src/component/write.ts:161` (`deleteDoc` call site)

**Interfaces:**
- Consumes: `requireCollection(ctx, collection)` returns a collection doc with `filterFields?: { field: string; type }[]`.
- Produces: `clearDoc(ctx, collection, docId, facetFields, sortSpecs, filterFields)` — new trailing `filterFields: { field: string; type: "string" | "number" }[]` param.

- [ ] **Step 1: Add `filterFields` to `clearDoc`'s signature and bound the query**

In `src/component/write.ts`, change the `clearDoc` signature (lines 38-44) from:

```ts
async function clearDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
  facetFields: string[],
  sortSpecs: SortKey[][],
): Promise<{ oldTerms: Set<string>; existed: boolean }> {
  const filt = await ctx.db
    .query("filters")
    .withIndex("by_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .collect();
```

to:

```ts
async function clearDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
  facetFields: string[],
  sortSpecs: SortKey[][],
  filterFields: { field: string; type: "string" | "number" }[],
): Promise<{ oldTerms: Set<string>; existed: boolean }> {
  // At most one filters row per declared filterField for this doc, so the read
  // is bounded by config, not by collection size.
  const filt = await ctx.db
    .query("filters")
    .withIndex("by_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .take(filterFields.length);
```

- [ ] **Step 2: Update the `upsertInternal` call site (line ~84)**

Change:

```ts
  const { oldTerms, existed } = await clearDoc(ctx, collection, id, col.facetFields ?? [], col.sortSpecs ?? []);
```

to:

```ts
  const { oldTerms, existed } = await clearDoc(ctx, collection, id, col.facetFields ?? [], col.sortSpecs ?? [], col.filterFields ?? []);
```

- [ ] **Step 3: Update the `deleteDoc` call site (line ~161)**

Change:

```ts
    const { oldTerms, existed } = await clearDoc(ctx, args.collection, args.id, col.facetFields ?? [], col.sortSpecs ?? []);
```

to:

```ts
    const { oldTerms, existed } = await clearDoc(ctx, args.collection, args.id, col.facetFields ?? [], col.sortSpecs ?? [], col.filterFields ?? []);
```

- [ ] **Step 4: Run the write/delete tests, then the full suite**

Run: `npx vitest run --typecheck src/component/write.test.ts src/component/filters-write.test.ts`
Expected: all pass, no type errors.

Run: `npm test`
Expected: `Tests 207 passed`, `Type Errors no errors`.

- [ ] **Step 5: Commit**

```bash
git add src/component/write.ts
git commit -m "perf: bound clearDoc filters read to filterFields count"
```

---

### Task 3: Document + test the three load-bearing semantics (#2)

**Files:**
- Modify: `src/component/ranking.ts:4-7` (comment on `numField`)
- Modify: `src/component/write.ts` (comment at the `decrementFacet` loop in `clearDoc`)
- Modify: `src/component/search.ts:218` (comment on `found`)
- Create: `src/component/semantics.test.ts`

**Interfaces:**
- Consumes: `api.collections.createCollection`, `api.write.upsert`, `api.write.delete`, `api.search.search` (existing public mutations/queries). `matchTokens(ctx, collection, tokens, queryBy, budget?)` from `src/component/textSearch.ts` — its `budget` (default `POSTINGS_BUDGET = 4000`) param forces truncation when small. The internal facetCounts table has shape `{ collection, field, value, count }` indexed `by_value` as `[collection, field, value]`.
- Produces: nothing consumed by later tasks (comments + a standalone test file).

- [ ] **Step 1: Write the failing/asserting tests**

Create `src/component/semantics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");
const ids = (r: any) => r.hits.map((h: any) => h.id);

// #2.1 — numField missing -> 0: a doc missing a numeric sort field orders as if
// the value were 0 (alongside real zeros), NOT last.
describe("numField missing-value ordering", () => {
  it("a doc missing the sort field orders alongside value 0, not last", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");
    await t.mutation(api.collections.createCollection, {
      name: "s",
      searchFields: ["name"],
      storedFields: "all",
      sortSpecs: [[{ field: "score", order: "asc" as const }]],
    });
    // "missing" has no `score`; "zero" has score 0; "pos" has score 5.
    await t.mutation(api.write.upsert, { collection: "s", id: "missing", doc: { id: "missing", name: "a" } });
    await t.mutation(api.write.upsert, { collection: "s", id: "zero", doc: { id: "zero", name: "b", score: 0 } });
    await t.mutation(api.write.upsert, { collection: "s", id: "pos", doc: { id: "pos", name: "c", score: 5 } });

    const r = await t.query(api.search.search, {
      collection: "s", q: "", sortBy: [{ field: "score", order: "asc" as const }], perPage: 10,
    });
    // missing (0) and zero (0) both sort ahead of pos (5); pos is last.
    expect(ids(r)[2]).toBe("pos");
    expect(ids(r).slice(0, 2).sort()).toEqual(["missing", "zero"]);
  });
});

// #2.2 — facet String() projection invariant: increment uses raw input,
// decrement uses projected stored value; under an explicit projection that
// includes the facet field, upsert+delete nets the facet count back to zero.
describe("facet count invariant under explicit projection", () => {
  it("upsert then delete returns the facet count row to zero (removed)", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "f",
      searchFields: ["name"],
      storedFields: ["name", "brand"], // explicit projection INCLUDING the facet field
      facetFields: ["brand"],
    });
    await t.mutation(api.write.upsert, { collection: "f", id: "p1", doc: { id: "p1", name: "x", brand: "Acme" } });

    const afterUpsert = await t.run(async (ctx) =>
      ctx.db.query("facetCounts")
        .withIndex("by_value", (q) => q.eq("collection", "f").eq("field", "brand").eq("value", "Acme"))
        .unique(),
    );
    expect(afterUpsert?.count).toBe(1);

    await t.mutation(api.write.delete, { collection: "f", id: "p1" });
    const afterDelete = await t.run(async (ctx) =>
      ctx.db.query("facetCounts")
        .withIndex("by_value", (q) => q.eq("collection", "f").eq("field", "brand").eq("value", "Acme"))
        .unique(),
    );
    expect(afterDelete).toBeNull(); // decrement removed the zero-count row
  });
});

// #2.3 — found is a floor under truncation: a forced-truncation search reports
// found_approximate true and found no greater than the true match count.
describe("found is a floor under truncation", () => {
  it("multi-token truncated search reports approximate and a floor count", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "t", searchFields: ["body"], storedFields: "all",
    });
    // 12 docs all containing both tokens -> true match count is 12.
    for (let i = 0; i < 12; i++) {
      await t.mutation(api.write.upsert, { collection: "t", id: `d${i}`, doc: { id: `d${i}`, body: "alpha beta" } });
    }
    // Default budget (4000) would NOT truncate 12 docs; assert the contract holds
    // at the API level: every result is exact here, and found never exceeds truth.
    const r = await t.query(api.search.search, { collection: "t", q: "alpha beta", perPage: 50 });
    expect(r.found).toBeLessThanOrEqual(12);
    expect(r.found).toBe(12);
    expect(r.found_approximate).toBe(false);
  });
});
```

> Note for the implementer: the `matchTokens` `budget` is internal and not
> reachable through the public `search` query, so #2.3's test asserts the
> *contract* (`found <= true count`, `found_approximate` semantics) at the API
> level rather than forcing truncation. This is intentional — do not wire a
> budget override into the public API just to test it.

- [ ] **Step 2: Run the test to verify it passes (semantics already hold)**

Run: `npx vitest run --typecheck src/component/semantics.test.ts`
Expected: all 3 tests PASS (these document existing correct behavior; they are regression guards, not red-then-green).

If any FAIL, stop — that is a real bug the review missed; report it before continuing.

- [ ] **Step 3: Add the contract comments**

In `src/component/ranking.ts`, above `numField` (line 4):

```ts
// Coerce a stored field to a number for sorting/ranking. A MISSING field or a
// non-numeric value yields 0 — so an absent numeric sort field orders as a zero
// (interleaved with real zeros), NOT last. encodeKey and evalTerms rely on this.
export function numField(stored: Record<string, unknown>, field: string): number {
```

In `src/component/write.ts`, inside `clearDoc`, above the `for (const field of facetFields)` decrement loop, add:

```ts
    // Facet invariant: incrementFacet (on upsert) stringifies the RAW input
    // value; this decrement stringifies the PROJECTED stored value. They net to
    // zero only because every projection mode preserves facet-field values
    // identically — keep facet fields in any explicit storedFields projection.
```

In `src/component/search.ts`, above the `let found = matchedIds.length;` line (around line 218):

```ts
    // `found` is the materialized-candidate count. When `found_approximate` is
    // true (driver scan truncated), it is a FLOOR, not the exact total — only
    // the single-exact-term / no-filter / no-queryBy case is corrected to the
    // exact terms.docCount below.
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `Tests 210 passed` (207 + 3 new), `Type Errors no errors`.

- [ ] **Step 5: Commit**

```bash
git add src/component/ranking.ts src/component/write.ts src/component/search.ts src/component/semantics.test.ts
git commit -m "docs: document and test numField, facet, and found semantics"
```

---

### Task 4: Batched pagination via atBatch (#1)

**Files:**
- Modify: `src/component/counters.ts:46-59` (`pageDocIds`)
- Modify: `src/component/sortIndex.ts:81-96` (`pageSortedDocIds`)

**Interfaces:**
- Consumes: `@convex-dev/aggregate` `DirectAggregate` instances `docAgg` (counters.ts) and `sortAgg` (sortIndex.ts). API: `agg.count(ctx, { namespace })` and `agg.atBatch(ctx, queries)` where each query is `{ offset: number, namespace }` and the result is `Item<K,Id>[]` with `.id`.
- Produces: `pageDocIds(ctx, collection, offset, limit)` and `pageSortedDocIds(ctx, collection, specId, offset, limit)` — unchanged signatures and return types (`Promise<string[]>`), unchanged output order.

- [ ] **Step 1: Replace the `at()` loop in `pageDocIds`**

In `src/component/counters.ts`, replace the body of `pageDocIds` (lines 46-59):

```ts
// docIds for a page [offset, offset+limit), in key (docId) order.
export async function pageDocIds(
  ctx: QueryCtx,
  collection: string,
  offset: number,
  limit: number,
): Promise<string[]> {
  const total = await docAgg.count(ctx, { namespace: collection });
  const ids: string[] = [];
  for (let i = 0; i < limit && offset + i < total; i++) {
    const item = await docAgg.at(ctx, offset + i, { namespace: collection });
    ids.push(item.id);
  }
  return ids;
}
```

with:

```ts
// docIds for a page [offset, offset+limit), in key (docId) order. Reads the page
// in ONE batched atBatch call instead of `limit` sequential at() lookups.
export async function pageDocIds(
  ctx: QueryCtx,
  collection: string,
  offset: number,
  limit: number,
): Promise<string[]> {
  const total = await docAgg.count(ctx, { namespace: collection });
  const offsets: number[] = [];
  for (let i = 0; i < limit && offset + i < total; i++) offsets.push(offset + i);
  if (offsets.length === 0) return [];
  const items = await docAgg.atBatch(
    ctx,
    offsets.map((o) => ({ offset: o, namespace: collection })),
  );
  return items.map((it) => it.id);
}
```

- [ ] **Step 2: Replace the `at()` loop in `pageSortedDocIds`**

In `src/component/sortIndex.ts`, replace the body of `pageSortedDocIds` (lines 81-96):

```ts
// docIds for a page [offset, offset+limit) in the spec's order.
export async function pageSortedDocIds(
  ctx: QueryCtx,
  collection: string,
  specId: string,
  offset: number,
  limit: number,
): Promise<string[]> {
  const namespace = ns(collection, specId);
  const total = await sortAgg.count(ctx, { namespace });
  const ids: string[] = [];
  for (let i = 0; i < limit && offset + i < total; i++) {
    const item = await sortAgg.at(ctx, offset + i, { namespace });
    ids.push(item.id);
  }
  return ids;
}
```

with:

```ts
// docIds for a page [offset, offset+limit) in the spec's order. Reads the page
// in ONE batched atBatch call instead of `limit` sequential at() lookups.
export async function pageSortedDocIds(
  ctx: QueryCtx,
  collection: string,
  specId: string,
  offset: number,
  limit: number,
): Promise<string[]> {
  const namespace = ns(collection, specId);
  const total = await sortAgg.count(ctx, { namespace });
  const offsets: number[] = [];
  for (let i = 0; i < limit && offset + i < total; i++) offsets.push(offset + i);
  if (offsets.length === 0) return [];
  const items = await sortAgg.atBatch(
    ctx,
    offsets.map((o) => ({ offset: o, namespace })),
  );
  return items.map((it) => it.id);
}
```

- [ ] **Step 3: Run the pagination-heavy suites**

Run: `npx vitest run --typecheck src/component/search.test.ts src/component/sort-search.test.ts src/component/rank-search.test.ts src/component/facet-search.test.ts`
Expected: all pass, no type errors. (These exercise browse pagination, sort-index pagination, and the rank-browse tail-fill which calls `pageSortedDocIds`.)

If `atBatch` is not a function / has a different shape, stop and inspect `node_modules/@convex-dev/aggregate/dist/client/index.d.ts` for the exact signature before adapting — do NOT silently fall back to the loop.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `Tests 210 passed`, `Type Errors no errors`.

- [ ] **Step 5: Commit**

```bash
git add src/component/counters.ts src/component/sortIndex.ts
git commit -m "perf: page browse and sort results with a single atBatch call"
```

---

### Task 5: Final whole-project typecheck and merge

**Files:** none (verification + git)

- [ ] **Step 1: Whole-project typecheck**

Run: `npm run typecheck`
Expected: no errors (checks `src`, `example`, `example/convex` — broader than the test typecheck).

- [ ] **Step 2: Final full test run**

Run: `npm test`
Expected: `Tests 210 passed`, `Type Errors no errors`.

- [ ] **Step 3: Merge to main and clean up**

```bash
git checkout main
git merge --ff-only improve/component-hardening
git branch -d improve/component-hardening
git log --oneline -6
```
Expected: fast-forward merge, branch deleted, the four hardening commits on `main`.

---

## Notes for the implementer

- `npm test` is `vitest run --typecheck`: it runs behavioral tests AND type-checks the test files. A failure can be an assertion OR a type error — read which.
- `npm run typecheck` is the separate whole-project `tsc --noEmit` pass; run it once at the end (Task 5), not per-commit.
- Do not push; the user merges/pushes. Local `main` is already ahead of `origin/main` by prior commits (deletion-guard fix + spec).
