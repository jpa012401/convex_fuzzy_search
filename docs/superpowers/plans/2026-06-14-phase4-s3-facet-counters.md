# Phase 4 S3 — Aggregate Facet Counters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maintain exact per-value facet counts in the write path so unfiltered browse+facets serves counts from a cardinality-bounded read instead of a full-collection scan.

**Architecture:** A new `facetCounts` table holds one row per `(collection, field, value)` with a running `count`, maintained incrementally in the write path for declared `facetFields` (mirroring the S2 filter-row lifecycle). Search adds one new lean path — browse + facets, no filter, no text, no custom order — that pages hits off the S1 doc aggregate and reads facet counts from `facetCounts`. All filter/text (query-scoped) facet paths stay exactly as they are (in-memory tally over the S2-bounded matched set).

**Tech Stack:** Convex component (TypeScript), `@convex-dev/aggregate` (already installed for S1 doc counts, used here only for paging the lean hits), `convex-test` + `vitest`.

**Spec:** `docs/superpowers/specs/2026-06-14-phase4-s3-facet-counters-design.md`

**Conventions this plan follows (read before starting):**
- `verbatimModuleSyntax` is on → import `MutationCtx`/`QueryCtx` with `import type`.
- Any test that calls `api.write.*` MUST `registerAggregate(t, "docCount")` (the write path calls `addDoc`). Import: `import { register as registerAggregate } from "@convex-dev/aggregate/test";`.
- `ctx.db.query().paginate()` THROWS inside a component — backfill uses manual cursor paging over `by_collection_doc` (see `src/component/backfill.ts`).
- Run a single test file with: `npx vitest run src/component/<file>`. Run all with: `npx vitest run`.
- `facetFields` is validated at `createCollection` time to be a subset of `storedFields`, so a facet field's value is always present identically in both the raw `doc` and the projected `stored` snapshot.

---

### Task 1: `facetCounts` table schema

**Files:**
- Modify: `src/component/schema.ts` (append a new table after the `filters` table, before the closing `});`)

- [ ] **Step 1: Add the table**

In `src/component/schema.ts`, add this table definition immediately after the `filters` table block (after its `.index("by_doc", ...)` line) and before the final `});`:

```ts
  facetCounts: defineTable({
    collection: v.string(),
    field: v.string(),
    value: v.string(),
    count: v.number(), // # docs in the collection whose stored `field` stringifies to `value`
  })
    .index("by_field", ["collection", "field"]) // enumerate all values for a field
    .index("by_value", ["collection", "field", "value"]), // locate the row to ++/--
```

- [ ] **Step 2: Verify codegen + typecheck**

Run: `npm run build`
Expected: build succeeds, no TypeScript errors. (This regenerates `_generated` so `"facetCounts"` is a known table name.)

- [ ] **Step 3: Commit**

```bash
git add src/component/schema.ts
git commit -m "feat(s3): facetCounts table for per-value facet counters"
```

---

### Task 2: `facetCounts.ts` helpers + unit tests

**Files:**
- Create: `src/component/facetCounts.ts`
- Create: `src/component/facetCounts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/component/facetCounts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import {
  incrementFacet,
  decrementFacet,
  readFacetCounts,
  clearCollectionFacets,
} from "./facetCounts";

const modules = import.meta.glob("./**/*.ts");

describe("facetCounts helpers", () => {
  it("increment creates then bumps a row", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await incrementFacet(ctx, "shop", "brand", "Aurora");
      await incrementFacet(ctx, "shop", "brand", "Aurora");
      const counts = await readFacetCounts(ctx, "shop", "brand", 10);
      expect(counts).toEqual([{ value: "Aurora", count: 2 }]);
    });
  });

  it("decrement lowers, and deletes the row at zero", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await incrementFacet(ctx, "shop", "brand", "Aurora");
      await decrementFacet(ctx, "shop", "brand", "Aurora");
      expect(await readFacetCounts(ctx, "shop", "brand", 10)).toEqual([]);
      // decrement on a missing row is a safe no-op
      await decrementFacet(ctx, "shop", "brand", "Aurora");
      expect(await readFacetCounts(ctx, "shop", "brand", 10)).toEqual([]);
    });
  });

  it("readFacetCounts sorts count desc then value asc, and respects maxValues", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await incrementFacet(ctx, "shop", "brand", "Beta"); // 1
      await incrementFacet(ctx, "shop", "brand", "Aurora");
      await incrementFacet(ctx, "shop", "brand", "Aurora"); // 2
      await incrementFacet(ctx, "shop", "brand", "Cobalt");
      await incrementFacet(ctx, "shop", "brand", "Cobalt"); // 2 (ties Aurora -> value asc)
      const top2 = await readFacetCounts(ctx, "shop", "brand", 2);
      expect(top2).toEqual([
        { value: "Aurora", count: 2 },
        { value: "Cobalt", count: 2 },
      ]);
    });
  });

  it("isolates fields and collections", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await incrementFacet(ctx, "shop", "brand", "Aurora");
      await incrementFacet(ctx, "shop", "category", "Aurora");
      await incrementFacet(ctx, "other", "brand", "Aurora");
      expect(await readFacetCounts(ctx, "shop", "brand", 10)).toEqual([{ value: "Aurora", count: 1 }]);
      await clearCollectionFacets(ctx, "shop");
      expect(await readFacetCounts(ctx, "shop", "brand", 10)).toEqual([]);
      expect(await readFacetCounts(ctx, "shop", "category", 10)).toEqual([]);
      // other collection untouched
      expect(await readFacetCounts(ctx, "other", "brand", 10)).toEqual([{ value: "Aurora", count: 1 }]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/component/facetCounts.test.ts`
Expected: FAIL — `facetCounts.ts` / its exports do not exist yet.

- [ ] **Step 3: Implement the helpers**

Create `src/component/facetCounts.ts`:

```ts
import type { MutationCtx, QueryCtx } from "./_generated/server";

// Increment the count for one (collection, field, value), creating the row on
// first sight. Used by the write path when a doc gains a facet value.
export async function incrementFacet(
  ctx: MutationCtx,
  collection: string,
  field: string,
  value: string,
) {
  const row = await ctx.db
    .query("facetCounts")
    .withIndex("by_value", (q) =>
      q.eq("collection", collection).eq("field", field).eq("value", value),
    )
    .unique();
  if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
  else await ctx.db.insert("facetCounts", { collection, field, value, count: 1 });
}

// Decrement the count for one (collection, field, value). Deletes the row when
// it reaches zero (no zero-count rows kept). Missing row -> safe no-op.
export async function decrementFacet(
  ctx: MutationCtx,
  collection: string,
  field: string,
  value: string,
) {
  const row = await ctx.db
    .query("facetCounts")
    .withIndex("by_value", (q) =>
      q.eq("collection", collection).eq("field", field).eq("value", value),
    )
    .unique();
  if (!row) return;
  if (row.count <= 1) await ctx.db.delete(row._id);
  else await ctx.db.patch(row._id, { count: row.count - 1 });
}

// Top `maxValues` (value, count) for a field, sorted count desc then value asc
// — identical ordering to the in-memory facet tally in search.ts. Bounded by
// the field's cardinality, not by the document count.
export async function readFacetCounts(
  ctx: QueryCtx,
  collection: string,
  field: string,
  maxValues: number,
): Promise<{ value: string; count: number }[]> {
  const rows = await ctx.db
    .query("facetCounts")
    .withIndex("by_field", (q) => q.eq("collection", collection).eq("field", field))
    .collect();
  return rows
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, Math.max(0, maxValues))
    .map((r) => ({ value: r.value, count: r.count }));
}

// Delete all facetCounts rows for a collection (used by deleteCollection and by
// the backfill's clear-then-rebuild). by_field's prefix is [collection], so
// eq("collection", ...) enumerates every (field, value) row for the collection.
export async function clearCollectionFacets(
  ctx: MutationCtx,
  collection: string,
) {
  const rows = await ctx.db
    .query("facetCounts")
    .withIndex("by_field", (q) => q.eq("collection", collection))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/component/facetCounts.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/component/facetCounts.ts src/component/facetCounts.test.ts
git commit -m "feat(s3): facetCounts increment/decrement/read/clear helpers"
```

---

### Task 3: Write-path maintenance + deleteCollection clear

**Files:**
- Modify: `src/component/write.ts` (`clearDoc` signature + facet decrement; `upsertInternal` facet increment; `deleteDoc` passes facetFields)
- Modify: `src/component/collections.ts` (`deleteCollection` clears facetCounts)
- Create: `src/component/facets-write.test.ts`

**Design note (decrement-then-increment, mirroring filters):** like postings and filter rows, facet maintenance is unconditional — `clearDoc` decrements the doc's *old* facet values (read from the existing `stored` snapshot) and `upsertInternal` increments its *new* values. A replace with an unchanged value nets to the same count (decrement to N−1 or row-delete, then increment back), so the final count is always correct; we do not special-case "unchanged."

- [ ] **Step 1: Write the failing test**

Create `src/component/facets-write.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { readFacetCounts } from "./facetCounts";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
    facetFields: ["brand", "category"],
  });
  return t;
}

const brandCounts = (t: any) =>
  t.run((ctx: any) => readFacetCounts(ctx, "shop", "brand", 10));

describe("write path maintains facet counts", () => {
  it("upsert increments each declared facet value", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "shoe", brand: "Aurora", category: "Footwear" } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "p2", doc: { name: "boot", brand: "Aurora", category: "Footwear" } });
    expect(await brandCounts(t)).toEqual([{ value: "Aurora", count: 2 }]);
  });

  it("replace with a changed value moves the count (no orphan, no double count)", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Aurora", category: "A" } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Nimbus", category: "A" } });
    expect(await brandCounts(t)).toEqual([{ value: "Nimbus", count: 1 }]);
  });

  it("replace with an unchanged value keeps the count correct", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Aurora", category: "A" } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "y", brand: "Aurora", category: "A" } });
    expect(await brandCounts(t)).toEqual([{ value: "Aurora", count: 1 }]);
  });

  it("missing/null facet value contributes no row", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", category: "A" } });
    expect(await brandCounts(t)).toEqual([]);
  });

  it("delete decrements", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Aurora", category: "A" } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "p2", doc: { name: "y", brand: "Aurora", category: "A" } });
    await t.mutation(api.write.delete, { collection: "shop", id: "p1" });
    expect(await brandCounts(t)).toEqual([{ value: "Aurora", count: 1 }]);
  });

  it("deleteCollection clears facet counts", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Aurora", category: "A" } });
    await t.mutation(api.collections.deleteCollection, { name: "shop" });
    // Recreate so readFacetCounts has a valid (empty) namespace to read.
    await t.mutation(api.collections.createCollection, { name: "shop", searchFields: ["name"], storedFields: "all", facetFields: ["brand"] });
    expect(await brandCounts(t)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/component/facets-write.test.ts`
Expected: FAIL — counts are empty / wrong because the write path does not maintain `facetCounts` yet.

- [ ] **Step 3: Wire facet maintenance into `write.ts`**

In `src/component/write.ts`:

a) Add the import near the other component imports (after the `addDoc, removeDoc` import):

```ts
import { incrementFacet, decrementFacet } from "./facetCounts";
```

b) Change `clearDoc` to accept `facetFields` and decrement old values. Replace the current `clearDoc` signature and its document-deletion tail. New signature:

```ts
async function clearDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
  facetFields: string[],
): Promise<{ oldTerms: Set<string>; existed: boolean }> {
```

And replace the existing document lookup/delete block (the `const existing = ...` through `if (existing) await ctx.db.delete(existing._id);` and the `return`) with:

```ts
  const existing = await ctx.db
    .query("documents")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .unique();
  if (existing) {
    const stored = existing.stored as Record<string, unknown>;
    for (const field of facetFields) {
      const raw = stored[field];
      if (raw === undefined || raw === null) continue;
      await decrementFacet(ctx, collection, field, String(raw));
    }
    await ctx.db.delete(existing._id);
  }

  return { oldTerms, existed: existing !== null };
```

c) In `upsertInternal`, update the `clearDoc` call to pass facet fields, and increment new facet values after inserting filter rows. Change:

```ts
  const { oldTerms, existed } = await clearDoc(ctx, collection, id);
```
to:
```ts
  const { oldTerms, existed } = await clearDoc(ctx, collection, id, col.facetFields ?? []);
```

Then, immediately after the existing `for (const f of col.filterFields ?? []) { ... }` block and before `await applyTermDiff(...)`, add:

```ts
  for (const field of col.facetFields ?? []) {
    const raw = doc[field];
    if (raw === undefined || raw === null) continue;
    await incrementFacet(ctx, collection, field, String(raw));
  }
```

d) In `deleteDoc`, capture the collection and pass its facet fields. Change:

```ts
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collection);
    const { oldTerms, existed } = await clearDoc(ctx, args.collection, args.id);
```
to:
```ts
  handler: async (ctx, args) => {
    const col = await requireCollection(ctx, args.collection);
    const { oldTerms, existed } = await clearDoc(ctx, args.collection, args.id, col.facetFields ?? []);
```

- [ ] **Step 4: Wire the clear into `deleteCollection`**

In `src/component/collections.ts`:

a) Add to the import from `./counters`:

```ts
import { clearCollectionFacets } from "./facetCounts";
```
(Add as a separate import line — `clearCollectionCount` is already imported from `./counters`; `clearCollectionFacets` lives in `./facetCounts`.)

b) In `deleteCollection`'s handler, immediately after the existing `await clearCollectionCount(ctx, args.name);` line, add:

```ts
    await clearCollectionFacets(ctx, args.name);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/component/facets-write.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npx vitest run`
Expected: all existing tests still pass plus the new ones.

- [ ] **Step 7: Commit**

```bash
git add src/component/write.ts src/component/collections.ts src/component/facets-write.test.ts
git commit -m "feat(s3): maintain facet counts in write path + clear on deleteCollection"
```

---

### Task 4: Search integration — lean browse + facets path

**Files:**
- Modify: `src/component/search.ts` (import `readFacetCounts`; add one new early-return branch)
- Create: `src/component/facet-search.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/component/facet-search.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function seeded() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
    filterFields: [{ field: "brand", type: "string" }],
    facetFields: ["brand", "category"],
  });
  const docs = [
    { id: "1", doc: { name: "red shoe", brand: "Aurora", category: "Footwear" } },
    { id: "2", doc: { name: "blue shoe", brand: "Aurora", category: "Footwear" } },
    { id: "3", doc: { name: "green hat", brand: "Nimbus", category: "Hats" } },
  ];
  for (const d of docs) await t.mutation(api.write.upsert, { collection: "shop", ...d });
  return t;
}

describe("browse + facets served from counters", () => {
  it("returns global facet counts with no filter/text/sort", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "", facetBy: ["brand", "category"] });
    expect(r.found).toBe(3);
    expect(r.out_of).toBe(3);
    expect(r.facet_counts).toEqual([
      { field_name: "brand", counts: [{ value: "Aurora", count: 2 }, { value: "Nimbus", count: 1 }] },
      { field_name: "category", counts: [{ value: "Footwear", count: 2 }, { value: "Hats", count: 1 }] },
    ]);
    // hits are paged off the aggregate (default perPage 10 -> all 3)
    expect(r.hits.length).toBe(3);
  });

  it("rejects an undeclared facet field", async () => {
    const t = await seeded();
    await expect(
      t.query(api.search.search, { collection: "shop", q: "", facetBy: ["price"] }),
    ).rejects.toThrow(/not a declared facet field/);
  });

  it("query-scoped facets (with filter) stay exact over the matched set", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "brand:Aurora", facetBy: ["category"] });
    expect(r.found).toBe(2);
    expect(r.facet_counts).toEqual([
      { field_name: "category", counts: [{ value: "Footwear", count: 2 }] },
    ]);
  });

  it("query-scoped facets (with text) stay exact over the matched set", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "shoe", facetBy: ["brand"] });
    expect(r.found).toBe(2);
    expect(r.facet_counts).toEqual([
      { field_name: "brand", counts: [{ value: "Aurora", count: 2 }] },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/component/facet-search.test.ts`
Expected: FAIL on the first test — the no-filter browse+facets path currently full-loads and tallies in-memory; but before Task 4's write-path counters were added (Task 3) it would also be wrong. With Task 3 in place the in-memory tally would actually still produce correct numbers, so to make this test meaningfully drive Task 4, the failing assertion is that the counters path is used. Practically: run it; if it already passes via the in-memory path, that is acceptable — the purpose of Task 4 is to *serve from counters without a full load*. Proceed to Step 3 regardless; Step 5 re-runs to confirm green.

- [ ] **Step 3: Add the lean browse+facets branch in `search.ts`**

a) Add `readFacetCounts` to the counters/facet imports. After the existing line `import { collectionCount, pageDocIds } from "./counters";`, add:

```ts
import { readFacetCounts } from "./facetCounts";
```

b) Immediately after the existing lean-browse early-return block (the one guarded by `tokens.length === 0 && !hasFilter && !hasFacets && !hasCustomOrder`, ending with its `return { ... facet_counts: [] };`), insert this new branch:

```ts
    // ---- LEAN BROWSE + FACETS: empty q, no filter, no custom order -> page off
    // the aggregate and read facet counts from the write-maintained counters.
    if (tokens.length === 0 && !hasFilter && hasFacets && !hasCustomOrder) {
      const ids = await pageDocIds(ctx, args.collection, (page - 1) * perPage, perPage);
      const byId = await loadDocs(ctx, args.collection, ids);
      const hits: Hit[] = ids.map((id) => ({
        document: (byId.get(id) ?? {}) as Record<string, unknown>,
        highlight: {},
        text_match: 0,
      }));
      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
      const facet_counts: FacetCount[] = [];
      for (const field of args.facetBy as string[]) {
        if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
        const counts = await readFacetCounts(ctx, args.collection, field, maxValues);
        facet_counts.push({ field_name: field, counts });
      }
      return { found: out_of, page, out_of, search_time_ms: Date.now() - start, hits, facet_counts };
    }
```

This leaves the later full-load `else` branch reachable only for browse **with a custom sort/rank** and no filter — the S4 target. Filter and text paths are untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/component/facet-search.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npx vitest run`
Expected: all green. Pay attention to `search.test.ts` — any existing browse+facets-no-filter case must return identical `facet_counts` (the ordering — count desc, value asc — matches the prior in-memory tally exactly).

- [ ] **Step 6: Commit**

```bash
git add src/component/search.ts src/component/facet-search.test.ts
git commit -m "feat(s3): serve unfiltered browse+facets from counters (no full load)"
```

---

### Task 5: Backfill + client method + example driver

**Files:**
- Modify: `src/component/backfill.ts` (add `backfillFacetCountsPage`)
- Modify: `src/client/index.ts` (add `backfillFacetCountsPage` client method)
- Modify: `example/convex/products.ts` (add `backfillFacets` self-chaining driver)
- Modify: `src/component/facets-write.test.ts` (add backfill rebuild + idempotency tests)

- [ ] **Step 1: Write the failing test**

Append these two tests inside the `describe("write path maintains facet counts", ...)` block in `src/component/facets-write.test.ts` (or a new `describe` in the same file):

```ts
  it("backfill rebuilds facet counts for pre-existing docs", async () => {
    const t = await setup();
    // Insert document rows directly, bypassing the write path (simulates pre-S3 docs).
    await t.run(async (ctx) => {
      await ctx.db.insert("documents", { collection: "shop", docId: "z1", stored: { name: "a", brand: "Aurora", category: "A" } });
      await ctx.db.insert("documents", { collection: "shop", docId: "z2", stored: { name: "b", brand: "Aurora", category: "B" } });
    });
    expect(await brandCounts(t)).toEqual([]);
    let cursor: string | null = null;
    do {
      const r: any = await t.mutation(api.backfill.backfillFacetCountsPage, { collection: "shop", cursor, batch: 1 });
      cursor = r.cursor;
    } while (cursor !== null);
    expect(await brandCounts(t)).toEqual([{ value: "Aurora", count: 2 }]);
  });

  it("backfill is idempotent (clears then rebuilds; re-run yields same counts)", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Aurora", category: "A" } });
    // First backfill run.
    let cursor: string | null = null;
    do {
      const r: any = await t.mutation(api.backfill.backfillFacetCountsPage, { collection: "shop", cursor, batch: 5 });
      cursor = r.cursor;
    } while (cursor !== null);
    expect(await brandCounts(t)).toEqual([{ value: "Aurora", count: 1 }]);
    // Second run must not double-count (clear-then-rebuild on first page).
    cursor = null;
    do {
      const r: any = await t.mutation(api.backfill.backfillFacetCountsPage, { collection: "shop", cursor, batch: 5 });
      cursor = r.cursor;
    } while (cursor !== null);
    expect(await brandCounts(t)).toEqual([{ value: "Aurora", count: 1 }]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/component/facets-write.test.ts`
Expected: FAIL — `api.backfill.backfillFacetCountsPage` does not exist.

- [ ] **Step 3: Implement the backfill mutation**

In `src/component/backfill.ts`:

a) Update the import from `./facetCounts` (add a new import line near the top, after the existing imports):

```ts
import { incrementFacet, clearCollectionFacets } from "./facetCounts";
```

b) Append this mutation at the end of the file:

```ts
// Backfill (rebuild) the `facetCounts` rows for a collection, one bounded page
// at a time. Re-derives each doc's declared facet values from its `stored`
// snapshot and increments the counters. Idempotent via clear-then-rebuild: on
// the first page (cursor === null) it clears the collection's existing facet
// rows, so a full run from the start is safe to repeat. For deployments that
// indexed documents before the S3 facet counters existed (the write path now
// maintains these automatically). Same manual cursor paging as the others.
export const backfillFacetCountsPage = mutation({
  args: {
    collection: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    batch: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const col = await requireCollection(ctx, args.collection);
    const batch = args.batch ?? 100;
    const cursor = args.cursor ?? null;
    // First page clears existing counts so the whole run is idempotent.
    if (cursor === null) await clearCollectionFacets(ctx, args.collection);
    const page = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) =>
        cursor === null
          ? q.eq("collection", args.collection)
          : q.eq("collection", args.collection).gt("docId", cursor),
      )
      .take(batch + 1);
    const rows = page.slice(0, batch);
    for (const d of rows) {
      const stored = d.stored as Record<string, unknown>;
      for (const field of col.facetFields ?? []) {
        const raw = stored[field];
        if (raw === undefined || raw === null) continue;
        await incrementFacet(ctx, args.collection, field, String(raw));
      }
    }
    const done = page.length <= batch;
    return { cursor: done ? null : rows[rows.length - 1].docId, done };
  },
});
```

(Confirm `requireCollection` is already imported in `backfill.ts` — it is, used by `backfillFiltersPage`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/component/facets-write.test.ts`
Expected: PASS (8 tests total in the file).

- [ ] **Step 5: Add the client method**

In `src/client/index.ts`, after the `backfillFiltersPage` method, add:

```ts
  // Rebuild the facet-count rows for a collection, one bounded page at a time.
  // Returns the next cursor (null when done). Idempotent (clear-then-rebuild on
  // the first page), so a full run from the start is safe to re-run. For
  // collections indexed before the S3 facet counters existed.
  async backfillFacetCountsPage(
    ctx: MutationCtx,
    args: { collection: string; cursor?: string | null; batch?: number },
  ): Promise<{ cursor: string | null; done: boolean }> {
    return ctx.runMutation(this.component.backfill.backfillFacetCountsPage, args);
  }
```

- [ ] **Step 6: Add the example driver**

In `example/convex/products.ts`, after the `backfillFilters` mutation, add:

```ts
// One-time facet-count backfill driver for collections indexed before the S3
// facet counters existed. Self-chains in the background like backfillFilters.
// Idempotent: the component clears the collection's facet rows on the first
// page (cursor null), so re-running from the start is safe.
export const backfillFacets = mutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), batch: v.optional(v.number()) },
  handler: async (ctx, { cursor, batch }) => {
    const r = await search.backfillFacetCountsPage(ctx, {
      collection: COLLECTION,
      cursor: cursor ?? null,
      batch: batch ?? 100,
    });
    if (!r.done) {
      await ctx.scheduler.runAfter(0, api.products.backfillFacets, { cursor: r.cursor, batch });
    }
    return r;
  },
});
```

- [ ] **Step 7: Typecheck + full suite**

Run: `npm run build && npx vitest run`
Expected: build + typecheck clean; all tests green.

- [ ] **Step 8: Commit**

```bash
git add src/component/backfill.ts src/client/index.ts example/convex/products.ts src/component/facets-write.test.ts
git commit -m "feat(s3): facet-count backfill (component + client + example driver)"
```

---

## Self-Review

**1. Spec coverage:**
- `facetCounts` table + indexes → Task 1. ✓
- Write-path increment/decrement for declared facetFields (upsert/replace/delete) → Task 3. ✓
- `deleteCollection` clears facet rows → Task 3 (Step 4). ✓
- Helpers in a focused module (`facetCounts.ts`) → Task 2. ✓
- New lean browse+facets path (no filter/text/custom-order) served from counters, paged off aggregate → Task 4. ✓
- Query-scoped facets unchanged → asserted in Task 4 tests; no code change to those paths. ✓
- Policy: no approximation flag, envelope shape unchanged → no `SearchResult`/`types.ts` change anywhere. ✓
- Idempotent backfill with clear-then-rebuild, batch ~100, manual cursor paging → Task 5. ✓
- Client method + example driver → Task 5. ✓
- Backfill idempotency + rebuild tests → Task 5. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✓

**3. Type consistency:** `incrementFacet`/`decrementFacet`/`readFacetCounts`/`clearCollectionFacets` signatures are identical across `facetCounts.ts` (def), `write.ts`, `collections.ts`, `backfill.ts`, and `search.ts` (uses). `readFacetCounts` returns `{ value; count }[]`, which is exactly the `counts` shape inside `FacetCount` (`{ field_name; counts: { value; count }[] }`). Table name `"facetCounts"` and indexes `by_field` / `by_value` match between schema (Task 1) and all callers. ✓

## Notes for the executor
- Tasks are ordered by dependency: schema → helpers → write path → search → backfill. Do them in order.
- After Task 3, the in-memory facet tally and the counters agree, so Task 4's first test may pass via either path — that is fine; Task 4's value is removing the full-collection load, verified by the suite staying green and the lean path being taken for unfiltered browse+facets.
- Do NOT touch `types.ts` / the `SearchResult` envelope — S3 introduces no new response fields.
