# Bucketed Filter Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat per-doc `filters` table with a chunked inverted index (`filterPostings`) so filter resolution reads O(matched / CHUNK) rows instead of one row per matched document, fixing the two slow benchmarks (`numeric range filter` 1188ms, `boolean+facet` 2189ms).

**Architecture:** Mirror the existing chunked-postings designs (`facetPostings.ts`, `postingChunks.ts`). Two posting shapes keyed off field type: **string/equality** postings bucket docKeys by `(collection, field, strVal)` fill-order (like `facetPostings`); **numeric** postings bucket docKeys by `(collection, field, valueBucket)` where `valueBucket = floor(numVal / NUMERIC_BUCKET_WIDTH)` so a range `[lo..hi]` reads only the contiguous bucket span and filters the two edge buckets in memory. The per-doc `filters` table is removed entirely (hard cutover, per design decision); `clearDoc` derives a doc's filter `(field,value)` pairs from its stored projection — valid because `filterFields ⊆ storedFields` is enforced at config time. Existing collections are migrated by replaying docs through `upsert` via the app's existing `reindex` mutation; the read path reports `complete: false` for a partially-migrated collection exactly as `facetPostings` already documents.

**Tech Stack:** Convex (component), TypeScript, vitest + convex-test, `@convex-dev/aggregate/test` harness.

## Global Constraints

- Component code lives in `src/component/`; never import app code into the component.
- Convex rule (from `example/convex/_generated/ai/guidelines.md`): index fields must be queried in declared order; range scans use `.withIndex(...).gte()/.lte()` on the last bound field, never `.filter()`.
- All `ctx.db` reads/writes inside one mutation/query share the 4,096-doc read limit and 16k-write limit; keep per-doc write fan-out bounded — chunk size stays `64` to match `FACET_CHUNK_SIZE`/`POSTING_CHUNK_SIZE`.
- Test command: `npm test` (`vitest run --typecheck`). Single file: `npx vitest run src/component/<file>.test.ts`.
- Test harness pattern (copy verbatim): `import { convexTest } from "convex-test"; import { register as registerAggregate } from "@convex-dev/aggregate/test"; import schema from "./schema"; const modules = import.meta.glob("./**/*.ts");` then `registerAggregate(t, "docCount");` after `convexTest(schema, modules)`.
- `NUMERIC_BUCKET_WIDTH = 256` and `FILTER_CHUNK_SIZE = 64` are the only tunables; export them so tests reference the constants, never literals.
- `FILTER_RESULT_BUDGET = 4000` stays the truncation cap and keeps its current name/value.
- The component public API surface (the `filters` table) is internal; removing it requires NO version bump beyond regenerating `_generated`. Run `npx convex codegen` (or `npx convex dev --once`) is NOT needed for the component's own `_generated` in tests — `convex-test` reads the schema directly. Regenerate the example app's component API types only if the example fails to typecheck (see Task 9).

---

## File Structure

- `src/component/filterPostings.ts` — **new.** The chunked filter index: `addStringPosting`, `removeStringPosting`, `addNumericPosting`, `removeNumericPosting`, `readStringPostingDocKeys`, and async-generator/range readers for numeric. One responsibility: maintain and read the `filterPostings` rows.
- `src/component/schema.ts` — **modify.** Remove the `filters` table; add the `filterPostings` table + indexes; add `filterPostings` to `statsResultValidator`.
- `src/component/filter.ts` — **modify.** Rewrite the `*Ids` resolution helpers (`strIds`, `numEqIds`, `numCmpIds`, `numRangeIds`) to read from `filterPostings` and return docKeys directly; keep the AST parser, predicate compiler, and `resolveAstToDocIds` AND/OR/inSet structure unchanged.
- `src/component/write.ts` — **modify.** In `upsertInternal`, write `filterPostings` instead of `filters` rows; in `clearDoc`, remove `filterPostings` derived from the stored projection instead of reading `filters` `by_doc`.
- `src/component/collections.ts` — **modify.** Replace the `filters` reads in `hasCollectionIndexRows` and `deleteCollectionRowsBatch` with `filterPostings` reads.
- `src/component/stats.ts` — **modify.** Add a `filterPostings` health section (total docKeys + distinct values per filter field).
- `src/component/facetPostings.ts` — **modify (doc only).** Update the backfill-contract comment to mention `filterPostings` alongside `filters`→`filterPostings`.
- Test files: `src/component/filterPostings.test.ts` (new), and edits to `filter-resolve.test.ts`, `filters-write.test.ts`, `collections.test.ts`, `search.test.ts`, `facet-search.test.ts`, `sync-reindex.test.ts`, `stats`-related tests — wherever they insert/read the `filters` table directly.

---

## Resolution helper contract (shared across tasks)

`filter.ts` keeps `resolveAstToDocIds(ctx, collection, ast, budget=FILTER_RESULT_BUDGET): Promise<ResolveResult>` where:

```ts
type ResolveResult = { ids: Set<string>; docKeys: Set<number>; truncated: boolean; complete: boolean };
```

**Important contract change:** with the per-doc `filters` table gone, the postings store only `docKey` (not `docId`). So leaf resolvers populate `docKeys` directly and **resolve `ids` from docKeys** only for the page that `search.ts` needs. To keep `resolveAstToDocIds`'s existing return shape, leaf resolvers return `ids` as an **empty set** and a populated `docKeys` set; `search.ts` is changed to page off `docKeys` and load docs via `loadDocumentByDocKey`. `complete` becomes always `true` for a fully-migrated collection (every posting has a docKey) and `false` only while a collection still has legacy state (detected via the collection's `pendingFields`, see Task 6). This is spelled out per-task below.

---

### Task 1: `filterPostings` schema + string posting read/write

**Files:**
- Modify: `src/component/schema.ts` (table def + remove `filters`)
- Create: `src/component/filterPostings.ts`
- Test: `src/component/filterPostings.test.ts`

**Interfaces:**
- Produces:
  - `export const FILTER_CHUNK_SIZE = 64`
  - `export const NUMERIC_BUCKET_WIDTH = 256`
  - `addStringPosting(ctx: MutationCtx, collection: string, docKey: number, field: string, value: string): Promise<void>`
  - `removeStringPosting(ctx: MutationCtx, collection: string, docKey: number, field: string, value: string): Promise<void>`
  - `readStringPostingDocKeys(ctx: QueryCtx, collection: string, field: string, value: string, budget: number): Promise<{ docKeys: number[]; truncated: boolean }>`
- Consumes: nothing (first task).

- [ ] **Step 1: Write the failing test**

Create `src/component/filterPostings.test.ts`:

```ts
/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import {
  FILTER_CHUNK_SIZE,
  addStringPosting,
  removeStringPosting,
  readStringPostingDocKeys,
} from "./filterPostings";

const modules = import.meta.glob("./**/*.ts");

describe("filterPostings — string (fill-based)", () => {
  it("fills the tail bucket before opening a new one", async () => {
    const t = convexTest(schema, modules);
    const N = FILTER_CHUNK_SIZE + 5;
    await t.run(async (ctx) => {
      for (let k = 0; k < N; k++) await addStringPosting(ctx, "c", k, "brand", "Aurora");
    });
    const { buckets, read } = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("filterPostings")
        .withIndex("by_str", (q) => q.eq("collection", "c").eq("field", "brand").eq("strVal", "Aurora"))
        .collect();
      const read = await readStringPostingDocKeys(ctx, "c", "brand", "Aurora", 10_000);
      return {
        buckets: rows.map((r) => r.docKeys.length).sort((a, b) => b - a),
        read: { docKeys: [...read.docKeys].sort((a, b) => a - b), truncated: read.truncated },
      };
    });
    expect(buckets).toEqual([FILTER_CHUNK_SIZE, 5]);
    expect(read.docKeys).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(read.truncated).toBe(false);
  });

  it("dedups a repeated docKey and removes/deletes an emptied bucket", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await addStringPosting(ctx, "c", 7, "f", "v");
      await addStringPosting(ctx, "c", 7, "f", "v");
      await removeStringPosting(ctx, "c", 7, "f", "v");
    });
    const { docKeys, rowCount } = await t.run(async (ctx) => {
      const r = await readStringPostingDocKeys(ctx, "c", "f", "v", 10_000);
      const rows = await ctx.db
        .query("filterPostings")
        .withIndex("by_str", (q) => q.eq("collection", "c").eq("field", "f").eq("strVal", "v"))
        .collect();
      return { docKeys: [...r.docKeys], rowCount: rows.length };
    });
    expect(docKeys).toEqual([]);
    expect(rowCount).toBe(0);
  });

  it("reports truncation when read exceeds budget", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let k = 0; k < 8; k++) await addStringPosting(ctx, "c", k, "f", "v");
    });
    const r = await t.run((ctx) => readStringPostingDocKeys(ctx, "c", "f", "v", 3));
    expect(r.docKeys.length).toBeLessThanOrEqual(3);
    expect(r.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/component/filterPostings.test.ts`
Expected: FAIL — `filterPostings.ts` does not exist / table `filterPostings` not in schema.

- [ ] **Step 3: Add the `filterPostings` table and remove `filters` in `schema.ts`**

In `src/component/schema.ts`, delete the entire `filters: defineTable({...})...` block (lines ~202-212) and replace it with:

```ts
  // Chunked inverted filter index. String/equality postings bucket docKeys by
  // FILL ORDER under (collection, field, strVal). Numeric postings bucket docKeys
  // by VALUE under (collection, field, valueBucket=floor(numVal/NUMERIC_BUCKET_WIDTH))
  // so a [lo..hi] range reads only the contiguous bucket span. A row carries
  // exactly one of strVal / numBucket (the kind is implied by the filter field type).
  filterPostings: defineTable({
    collection: v.string(),
    field: v.string(),
    strVal: v.optional(v.string()),
    numBucket: v.optional(v.number()),
    bucket: v.number(),
    docKeys: v.array(v.number()),
  })
    .index("by_str", ["collection", "field", "strVal", "bucket"])
    .index("by_num", ["collection", "field", "numBucket", "bucket"]),
```

- [ ] **Step 4: Create `src/component/filterPostings.ts` (string half)**

```ts
import type { MutationCtx, QueryCtx } from "./_generated/server";

// Chunked inverted filter index. Mirrors facetPostings (fill-based) for string
// equality, and adds value-bucketed numeric postings (Task 2) for range scans.
export const FILTER_CHUNK_SIZE = 64;
export const NUMERIC_BUCKET_WIDTH = 256;

function insertSorted(arr: number[], x: number): number[] {
  if (arr.includes(x)) return arr;
  const out = [...arr, x];
  out.sort((a, b) => a - b);
  return out;
}

async function strTailBucket(ctx: QueryCtx, collection: string, field: string, value: string) {
  return await ctx.db
    .query("filterPostings")
    .withIndex("by_str", (q) => q.eq("collection", collection).eq("field", field).eq("strVal", value))
    .order("desc")
    .first();
}

export async function addStringPosting(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  field: string,
  value: string,
): Promise<void> {
  const tail = await strTailBucket(ctx, collection, field, value);
  if (!tail) {
    await ctx.db.insert("filterPostings", { collection, field, strVal: value, bucket: 0, docKeys: [docKey] });
    return;
  }
  if (tail.docKeys.includes(docKey)) return; // caller fully removes before re-adding; guards same-tail dup only
  if (tail.docKeys.length < FILTER_CHUNK_SIZE) {
    await ctx.db.patch(tail._id, { docKeys: insertSorted(tail.docKeys, docKey) });
  } else {
    await ctx.db.insert("filterPostings", { collection, field, strVal: value, bucket: tail.bucket + 1, docKeys: [docKey] });
  }
}

export async function removeStringPosting(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  field: string,
  value: string,
): Promise<void> {
  const rows = await ctx.db
    .query("filterPostings")
    .withIndex("by_str", (q) => q.eq("collection", collection).eq("field", field).eq("strVal", value))
    .collect();
  for (const row of rows) {
    if (!row.docKeys.includes(docKey)) continue;
    const next = row.docKeys.filter((k) => k !== docKey);
    if (next.length === 0) await ctx.db.delete(row._id);
    else await ctx.db.patch(row._id, { docKeys: next });
  }
}

export async function readStringPostingDocKeys(
  ctx: QueryCtx,
  collection: string,
  field: string,
  value: string,
  budget: number,
): Promise<{ docKeys: number[]; truncated: boolean }> {
  const seen = new Set<number>();
  let truncated = false;
  const rows = ctx.db
    .query("filterPostings")
    .withIndex("by_str", (q) => q.eq("collection", collection).eq("field", field).eq("strVal", value));
  for await (const row of rows) {
    for (const k of row.docKeys) {
      seen.add(k);
      if (seen.size > budget) { truncated = true; break; }
    }
    if (truncated) break;
  }
  const docKeys = [...seen].slice(0, budget);
  return { docKeys, truncated };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/component/filterPostings.test.ts`
Expected: PASS (3 tests). (Numeric tests come in Task 2.)

- [ ] **Step 6: Commit**

```bash
git add src/component/schema.ts src/component/filterPostings.ts src/component/filterPostings.test.ts
git commit -m "feat: add filterPostings table + string posting read/write"
```

---

### Task 2: Numeric value-bucketed postings (range-queryable)

**Files:**
- Modify: `src/component/filterPostings.ts`
- Test: `src/component/filterPostings.test.ts`

**Interfaces:**
- Produces:
  - `addNumericPosting(ctx: MutationCtx, collection: string, docKey: number, field: string, num: number): Promise<void>`
  - `removeNumericPosting(ctx: MutationCtx, collection: string, docKey: number, field: string, num: number): Promise<void>`
  - `readNumericRangeDocKeys(ctx: QueryCtx, collection: string, field: string, lo: number, hi: number, budget: number): Promise<{ docKeys: number[]; truncated: boolean }>` — `lo`/`hi` inclusive; use `±Infinity` for open comparators.
- Consumes: `FILTER_CHUNK_SIZE`, `NUMERIC_BUCKET_WIDTH` from Task 1.

**Design note:** A numeric posting row is keyed by `numBucket = Math.floor(num / NUMERIC_BUCKET_WIDTH)`. Within one `numBucket`, docKeys whose values all fall in `[numBucket*W, (numBucket+1)*W)` are fill-bucketed (sub-`bucket` 0,1,...) like the string side. A range `[lo..hi]` reads `numBucket ∈ [floor(lo/W) .. floor(hi/W)]` via the `by_num` index range scan, then keeps a docKey only if its actual value is in `[lo,hi]`. Because a posting row stores only docKeys (not values), the edge-bucket value check needs the value — so numeric posting rows additionally store the docKey→value pairs they hold. Store `entries: { docKey, num }[]` for numeric rows instead of bare `docKeys`. **Revise the schema to support this** (see Step 3).

- [ ] **Step 1: Write the failing test**

Append to `src/component/filterPostings.test.ts`:

```ts
import {
  NUMERIC_BUCKET_WIDTH,
  addNumericPosting,
  removeNumericPosting,
  readNumericRangeDocKeys,
} from "./filterPostings";

describe("filterPostings — numeric (value-bucketed range)", () => {
  it("resolves an inclusive range across bucket boundaries", async () => {
    const t = convexTest(schema, modules);
    // values spanning 3 numeric buckets at W=256: 50, 110, 150, 300, 600
    const vals = [
      { k: 1, v: 50 },
      { k: 2, v: 110 },
      { k: 3, v: 150 },
      { k: 4, v: 300 },
      { k: 5, v: 600 },
    ];
    await t.run(async (ctx) => {
      for (const { k, v } of vals) await addNumericPosting(ctx, "c", k, "price", v);
    });
    const inRange = await t.run((ctx) => readNumericRangeDocKeys(ctx, "c", "price", 50, 150, 10_000));
    expect([...inRange.docKeys].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(inRange.truncated).toBe(false);

    const open = await t.run((ctx) =>
      readNumericRangeDocKeys(ctx, "c", "price", 100, Number.POSITIVE_INFINITY, 10_000),
    );
    expect([...open.docKeys].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
  });

  it("removes a docKey from its numeric bucket and deletes an emptied row", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await addNumericPosting(ctx, "c", 9, "price", 42);
      await removeNumericPosting(ctx, "c", 9, "price", 42);
    });
    const r = await t.run((ctx) => readNumericRangeDocKeys(ctx, "c", "price", 0, 1000, 10_000));
    expect([...r.docKeys]).toEqual([]);
  });

  it("uses NUMERIC_BUCKET_WIDTH to bucket values", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await addNumericPosting(ctx, "c", 1, "price", NUMERIC_BUCKET_WIDTH - 1); // bucket 0
      await addNumericPosting(ctx, "c", 2, "price", NUMERIC_BUCKET_WIDTH); // bucket 1
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("filterPostings")
        .withIndex("by_num", (q) => q.eq("collection", "c").eq("field", "price"))
        .collect(),
    );
    expect(rows.map((r) => r.numBucket).sort((a, b) => (a! - b!))).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/component/filterPostings.test.ts`
Expected: FAIL — `addNumericPosting` is not exported; `entries` field not in schema.

- [ ] **Step 3: Revise the `filterPostings` schema for numeric entries**

In `src/component/schema.ts`, change the `filterPostings` table so numeric rows can store `(docKey, num)` pairs while string rows keep bare `docKeys`:

```ts
  filterPostings: defineTable({
    collection: v.string(),
    field: v.string(),
    // string rows: strVal set, docKeys holds the fill-bucketed docKeys.
    strVal: v.optional(v.string()),
    docKeys: v.optional(v.array(v.number())),
    // numeric rows: numBucket set, entries holds (docKey, num) so edge buckets
    // can be value-filtered for a range without a separate value lookup.
    numBucket: v.optional(v.number()),
    entries: v.optional(v.array(v.object({ docKey: v.number(), num: v.number() }))),
    bucket: v.number(),
  })
    .index("by_str", ["collection", "field", "strVal", "bucket"])
    .index("by_num", ["collection", "field", "numBucket", "bucket"]),
```

Update Task 1's string functions to read/write `docKeys` (unchanged) — they already use `docKeys`, which is now optional; treat `row.docKeys ?? []`.

- [ ] **Step 4: Add numeric functions to `filterPostings.ts`**

```ts
function numBucketOf(num: number): number {
  return Math.floor(num / NUMERIC_BUCKET_WIDTH);
}

async function numTailBucket(ctx: QueryCtx, collection: string, field: string, numBucket: number) {
  return await ctx.db
    .query("filterPostings")
    .withIndex("by_num", (q) => q.eq("collection", collection).eq("field", field).eq("numBucket", numBucket))
    .order("desc")
    .first();
}

export async function addNumericPosting(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  field: string,
  num: number,
): Promise<void> {
  const numBucket = numBucketOf(num);
  const tail = await numTailBucket(ctx, collection, field, numBucket);
  const entry = { docKey, num };
  if (!tail) {
    await ctx.db.insert("filterPostings", { collection, field, numBucket, bucket: 0, entries: [entry] });
    return;
  }
  if ((tail.entries ?? []).some((e) => e.docKey === docKey)) return;
  if ((tail.entries ?? []).length < FILTER_CHUNK_SIZE) {
    await ctx.db.patch(tail._id, { entries: [...(tail.entries ?? []), entry] });
  } else {
    await ctx.db.insert("filterPostings", { collection, field, numBucket, bucket: tail.bucket + 1, entries: [entry] });
  }
}

export async function removeNumericPosting(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  field: string,
  num: number,
): Promise<void> {
  const numBucket = numBucketOf(num);
  const rows = await ctx.db
    .query("filterPostings")
    .withIndex("by_num", (q) => q.eq("collection", collection).eq("field", field).eq("numBucket", numBucket))
    .collect();
  for (const row of rows) {
    const entries = row.entries ?? [];
    if (!entries.some((e) => e.docKey === docKey)) continue;
    const next = entries.filter((e) => e.docKey !== docKey);
    if (next.length === 0) await ctx.db.delete(row._id);
    else await ctx.db.patch(row._id, { entries: next });
  }
}

export async function readNumericRangeDocKeys(
  ctx: QueryCtx,
  collection: string,
  field: string,
  lo: number,
  hi: number,
  budget: number,
): Promise<{ docKeys: number[]; truncated: boolean }> {
  const loB = Number.isFinite(lo) ? numBucketOf(lo) : Number.NEGATIVE_INFINITY;
  const hiB = Number.isFinite(hi) ? numBucketOf(hi) : Number.POSITIVE_INFINITY;
  const seen = new Set<number>();
  let truncated = false;
  const q = ctx.db
    .query("filterPostings")
    .withIndex("by_num", (qb) => {
      let b = qb.eq("collection", collection).eq("field", field);
      if (Number.isFinite(loB)) b = b.gte("numBucket", loB as number);
      if (Number.isFinite(hiB)) b = b.lte("numBucket", hiB as number);
      return b;
    });
  for await (const row of q) {
    for (const e of row.entries ?? []) {
      if (e.num < lo || e.num > hi) continue; // edge-bucket value filter
      seen.add(e.docKey);
      if (seen.size > budget) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return { docKeys: [...seen].slice(0, budget), truncated };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/component/filterPostings.test.ts`
Expected: PASS (all string + numeric tests).

- [ ] **Step 6: Commit**

```bash
git add src/component/schema.ts src/component/filterPostings.ts src/component/filterPostings.test.ts
git commit -m "feat: add numeric value-bucketed filter postings for range scans"
```

---

### Task 3: Rewrite `filter.ts` resolution to read from `filterPostings`

**Files:**
- Modify: `src/component/filter.ts`
- Test: `src/component/filter-resolve.test.ts`

**Interfaces:**
- Consumes: `readStringPostingDocKeys`, `readNumericRangeDocKeys` (Tasks 1-2).
- Produces: unchanged signature `resolveAstToDocIds(ctx, collection, ast, budget?) : Promise<ResolveResult>`, where `ResolveResult = { ids: Set<string>; docKeys: Set<number>; truncated: boolean; complete: boolean }`. **`ids` is now always an empty set** (docIds are resolved later, per-page, in `search.ts`); `docKeys` carries the result. `complete` is `true` (postings always carry docKeys); the partial-migration signal moves to the collection's `pendingFields` (Task 6).

- [ ] **Step 1: Rewrite the leaf resolvers (failing test first)**

Edit `src/component/filter-resolve.test.ts`. The current `seedFilters` inserts into the removed `filters` table — replace it to seed via the public write path so postings are built. Replace the whole `seedFilters` + `resolve` helpers and the first test with:

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { parseFilterAst, resolveAstToDocIds } from "./filter";

const modules = import.meta.glob("./**/*.ts");
const types = { brand: "string", price: "number" } as const;

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
    filterFields: [
      { field: "brand", type: "string" as const },
      { field: "price", type: "number" as const },
    ],
  });
  const docs = [
    { id: "a", brand: "Aurora", price: 90 },
    { id: "b", brand: "Aurora", price: 110 },
    { id: "c", brand: "Nimbus", price: 150 },
  ];
  for (const d of docs) {
    await t.mutation(api.write.upsert, { collection: "shop", id: d.id, doc: { name: d.id, brand: d.brand, price: d.price } });
  }
  return t;
}

// Resolve to the set of docIds by mapping docKeys -> documents.by_collection_docKey.
const resolveIds = async (t: any, expr: string): Promise<Set<string>> => {
  const ids: string[] = await t.run(async (ctx: any) => {
    const r = await resolveAstToDocIds(ctx, "shop", parseFilterAst(expr, types));
    const out: string[] = [];
    for (const k of r.docKeys) {
      const doc = await ctx.db
        .query("documents")
        .withIndex("by_collection_docKey", (q: any) => q.eq("collection", "shop").eq("docKey", k))
        .unique();
      if (doc) out.push(doc.docId);
    }
    return out;
  });
  return new Set(ids);
};
const sorted = (s: Set<string>) => [...s].sort();

describe("resolveAstToDocIds (filterPostings-backed)", () => {
  it("exact, in-set, comparator, range, AND, OR", async () => {
    const t = await setup();
    expect(sorted(await resolveIds(t, "brand:Aurora"))).toEqual(["a", "b"]);
    expect(sorted(await resolveIds(t, "brand:[Aurora,Nimbus]"))).toEqual(["a", "b", "c"]);
    expect(sorted(await resolveIds(t, "price:>100"))).toEqual(["b", "c"]);
    expect(sorted(await resolveIds(t, "price:[100..200]"))).toEqual(["b", "c"]);
    expect(sorted(await resolveIds(t, "brand:Aurora && price:>100"))).toEqual(["b"]);
    expect(sorted(await resolveIds(t, "brand:Nimbus || price:<100"))).toEqual(["a", "c"]);
  });

  it("caps broad reads and reports truncation (on docKeys)", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "shop", searchFields: ["name"], storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }],
    });
    for (let i = 0; i < 8; i++) {
      await t.mutation(api.write.upsert, { collection: "shop", id: `p${i}`, doc: { name: "n", brand: "Aurora" } });
    }
    const result = await t.run(async (ctx: any) => {
      const r = await resolveAstToDocIds(ctx, "shop", parseFilterAst("brand:Aurora", { brand: "string" }), 3);
      return { size: r.docKeys.size, truncated: r.truncated };
    });
    expect(result.size).toBeLessThanOrEqual(3);
    expect(result.truncated).toBe(true);
  });
});
```

Delete the old `seedFilters`-based tests "comparators exclude rows with no numeric value" and "resolves a filter to docKeys and reports complete" — the first tested a `filters`-table edge case that no longer exists (non-coercible numerics are simply never written as numeric postings, see Task 4 write path), and the second is now covered by the AND/OR test above. (If you want to retain a complete-flag test, it moves to Task 6.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/component/filter-resolve.test.ts`
Expected: FAIL — leaf resolvers still query the removed `filters` table.

- [ ] **Step 3: Rewrite the leaf resolvers in `filter.ts`**

Keep `tokenize`, `parseFilterAst`, `astToPredicate`, `parseFilter`, and the `resolveAstToDocIds` AND/OR/inSet skeleton. Replace the four DB helpers and the `exact`/`cmp`/`range` leaves. Replace lines ~195-309 (`rowsToResult` through end of `resolveAstToDocIds`) with:

```ts
import { readStringPostingDocKeys, readNumericRangeDocKeys } from "./filterPostings";

type ResolveResult = { ids: Set<string>; docKeys: Set<number>; truncated: boolean; complete: boolean };

function keysResult(r: { docKeys: number[]; truncated: boolean }): ResolveResult {
  return { ids: new Set<string>(), docKeys: new Set(r.docKeys), truncated: r.truncated, complete: true };
}

async function strKeys(ctx: QueryCtx, collection: string, field: string, value: string, budget: number) {
  return keysResult(await readStringPostingDocKeys(ctx, collection, field, value, budget));
}
async function numEqKeys(ctx: QueryCtx, collection: string, field: string, num: number, budget: number) {
  return keysResult(await readNumericRangeDocKeys(ctx, collection, field, num, num, budget));
}
async function numCmpKeys(ctx: QueryCtx, collection: string, field: string, op: string, num: number, budget: number) {
  const lo = op === ">" ? num + epsilonAbove(num) : op === ">=" ? num : Number.NEGATIVE_INFINITY;
  const hi = op === "<" ? num - epsilonBelow(num) : op === "<=" ? num : Number.POSITIVE_INFINITY;
  return keysResult(await readNumericRangeDocKeys(ctx, collection, field, lo, hi, budget));
}
async function numRangeKeys(ctx: QueryCtx, collection: string, field: string, lo: number, hi: number, budget: number) {
  return keysResult(await readNumericRangeDocKeys(ctx, collection, field, lo, hi, budget));
}

// Strict comparators on real numbers: exclude the boundary exactly. Since the
// posting value filter is `e.num < lo || e.num > hi`, shift the inclusive bound
// by the smallest representable step so `>` / `<` exclude equality.
function epsilonAbove(n: number): number { return n === 0 ? Number.MIN_VALUE : Math.abs(n) * Number.EPSILON; }
function epsilonBelow(n: number): number { return n === 0 ? Number.MIN_VALUE : Math.abs(n) * Number.EPSILON; }

export async function resolveAstToDocIds(
  ctx: QueryCtx,
  collection: string,
  ast: Ast,
  budget: number = FILTER_RESULT_BUDGET,
): Promise<ResolveResult> {
  switch (ast.kind) {
    case "and": {
      const a = await resolveAstToDocIds(ctx, collection, ast.left, budget);
      const b = await resolveAstToDocIds(ctx, collection, ast.right, budget);
      const [smallK, bigK] = a.docKeys.size <= b.docKeys.size ? [a.docKeys, b.docKeys] : [b.docKeys, a.docKeys];
      const outK = new Set<number>();
      for (const k of smallK) if (bigK.has(k)) outK.add(k);
      return { ids: new Set<string>(), docKeys: outK, truncated: a.truncated || b.truncated, complete: a.complete && b.complete };
    }
    case "or": {
      const a = await resolveAstToDocIds(ctx, collection, ast.left, budget);
      const b = await resolveAstToDocIds(ctx, collection, ast.right, budget);
      const outK = new Set<number>(a.docKeys);
      let truncated = a.truncated || b.truncated;
      for (const k of b.docKeys) {
        if (outK.size >= budget) { truncated = true; break; }
        outK.add(k);
      }
      return { ids: new Set<string>(), docKeys: outK, truncated, complete: a.complete && b.complete };
    }
    case "exact":
      return ast.type === "number"
        ? await numEqKeys(ctx, collection, ast.field, Number(ast.value), budget)
        : await strKeys(ctx, collection, ast.field, ast.value, budget);
    case "inSet": {
      const outK = new Set<number>();
      let truncated = false;
      for (const v of ast.values) {
        const r = ast.type === "number"
          ? await numEqKeys(ctx, collection, ast.field, Number(v), budget)
          : await strKeys(ctx, collection, ast.field, v, budget);
        truncated ||= r.truncated;
        for (const k of r.docKeys) {
          if (outK.size >= budget) { truncated = true; break; }
          outK.add(k);
        }
      }
      return { ids: new Set<string>(), docKeys: outK, truncated, complete: true };
    }
    case "cmp":
      return await numCmpKeys(ctx, collection, ast.field, ast.op, ast.num, budget);
    case "range":
      return await numRangeKeys(ctx, collection, ast.field, ast.lo, ast.hi, budget);
  }
}
```

Keep the `FILTER_RESULT_BUDGET` export at the top of the file. Remove the now-unused `rowsToResult` and the old `*Ids` functions.

> **Strict-comparator note for the implementer:** the `epsilonAbove/Below` approach handles the common case but is fragile for large integers where `EPSILON` underflows. **Simpler, exact alternative — prefer this:** pass the inclusive bound plus a strictness flag into `readNumericRangeDocKeys` and apply `e.num <= lo`/`e.num >= hi` exclusion there. If you take the flag approach, change `readNumericRangeDocKeys`'s signature to accept `(lo, hi, loInclusive, hiInclusive, budget)` and update Task 2's edge filter to `(e.num < lo || (!loInclusive && e.num === lo) || e.num > hi || (!hiInclusive && e.num === hi))`. Add a test: `price:>100` must EXCLUDE a doc priced exactly 100. Pick one approach and make the test prove boundary exclusion.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/component/filter-resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/component/filter.ts src/component/filter-resolve.test.ts
git commit -m "feat: resolve filters from the bucketed filterPostings index"
```

---

### Task 4: Write path — build `filterPostings` on upsert, remove on clear

**Files:**
- Modify: `src/component/write.ts`
- Test: `src/component/filters-write.test.ts`

**Interfaces:**
- Consumes: `addStringPosting`, `removeStringPosting`, `addNumericPosting`, `removeNumericPosting` (Tasks 1-2); existing `project`, `requireCollection`, `ensureDocKey`.
- Produces: `upsertInternal`/`clearDoc` maintain `filterPostings` instead of `filters`.

- [ ] **Step 1: Write the failing test**

Open `src/component/filters-write.test.ts`. It currently asserts on `filters`-table rows. Replace its body's assertions to read `filterPostings`. Replace the file's first test with (keep its existing `setup()` if present, else use the harness pattern):

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { readStringPostingDocKeys, readNumericRangeDocKeys } from "./filterPostings";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "shop", searchFields: ["name"], storedFields: "all",
    filterFields: [
      { field: "brand", type: "string" as const },
      { field: "price", type: "number" as const },
    ],
  });
  return t;
}

describe("write path maintains filterPostings", () => {
  it("upsert adds string + numeric postings; delete removes them", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "a", doc: { name: "x", brand: "Aurora", price: 90 } });

    const after = await t.run(async (ctx) => ({
      brand: (await readStringPostingDocKeys(ctx, "shop", "brand", "Aurora", 1000)).docKeys.length,
      price: (await readNumericRangeDocKeys(ctx, "shop", "price", 90, 90, 1000)).docKeys.length,
    }));
    expect(after).toEqual({ brand: 1, price: 1 });

    await t.mutation(api.write.delete, { collection: "shop", id: "a" });
    const afterDel = await t.run(async (ctx) => ({
      brand: (await readStringPostingDocKeys(ctx, "shop", "brand", "Aurora", 1000)).docKeys.length,
      price: (await readNumericRangeDocKeys(ctx, "shop", "price", 90, 90, 1000)).docKeys.length,
    }));
    expect(afterDel).toEqual({ brand: 0, price: 0 });
  });

  it("re-upsert with a changed value moves the posting (no stale key)", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "a", doc: { name: "x", brand: "Aurora", price: 90 } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "a", doc: { name: "x", brand: "Nimbus", price: 150 } });
    const counts = await t.run(async (ctx) => ({
      aurora: (await readStringPostingDocKeys(ctx, "shop", "brand", "Aurora", 1000)).docKeys.length,
      nimbus: (await readStringPostingDocKeys(ctx, "shop", "brand", "Nimbus", 1000)).docKeys.length,
      p90: (await readNumericRangeDocKeys(ctx, "shop", "price", 90, 90, 1000)).docKeys.length,
      p150: (await readNumericRangeDocKeys(ctx, "shop", "price", 150, 150, 1000)).docKeys.length,
    }));
    expect(counts).toEqual({ aurora: 0, nimbus: 1, p90: 0, p150: 1 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/component/filters-write.test.ts`
Expected: FAIL — `upsertInternal` still inserts into `filters`; `clearDoc` reads `filters`.

- [ ] **Step 3: Update `clearDoc` to remove postings from the stored projection**

In `src/component/write.ts`, in `clearDoc`, DELETE the leading `filters`-table read+delete block (lines ~50-57). Then, inside the `if (existing)` block, after the facet removal, add filter-posting removal derived from `existing.stored` (the same source facet removal already uses). You need the collection's `filterFields`; thread it in. Change `clearDoc`'s signature to also accept `filterFields`:

```ts
async function clearDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
  facetFields: string[],
  sortSpecs: SortKey[][],
  filterFields: { field: string; type: "string" | "number" }[],
): Promise<{ oldTerms: Set<string>; existed: boolean }> {
```

Remove the old `filters` `by_doc` collect/delete entirely. Inside `if (existing)`, after `removeFacetPostings(...)`, add:

```ts
    for (const f of filterFields) {
      const raw = stored[f.field];
      if (raw === undefined || raw === null) continue;
      if (f.type === "string") {
        await removeStringPosting(ctx, collection, existing.docKey, f.field, String(raw));
      } else {
        const num = Number(raw);
        if (!Number.isNaN(num)) await removeNumericPosting(ctx, collection, existing.docKey, f.field, num);
      }
    }
```

Update the two `clearDoc(...)` call sites (`upsertInternal` line ~98 and `deleteDoc` line ~181) to pass `col.filterFields ?? []`.

> **Invariant the implementer must preserve:** removal stringifies the **projected stored** value; the add (below) stringifies the **raw input** value. These net to zero only because `filterFields ⊆ storedFields` is enforced in `validateCollectionConfig` ([collections.ts](src/component/collections.ts)) and projection preserves those fields identically — the same invariant the existing facet remove/add pair already relies on. Do not change projection for filter fields.

- [ ] **Step 4: Update `upsertInternal` to write postings instead of `filters` rows**

In `src/component/write.ts`, replace the `for (const f of col.filterFields ?? [])` block that inserts into `filters` (lines ~124-147) with:

```ts
  for (const f of col.filterFields ?? []) {
    const value = doc[f.field];
    if (value === undefined || value === null) continue;
    if (f.type === "string") {
      await addStringPosting(ctx, collection, docKey, f.field, String(value));
    } else {
      const num = Number(value);
      if (!Number.isNaN(num)) await addNumericPosting(ctx, collection, docKey, f.field, num);
    }
  }
```

Update imports at the top of `write.ts`:

```ts
import { addStringPosting, removeStringPosting, addNumericPosting, removeNumericPosting } from "./filterPostings";
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/component/filters-write.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/component/write.ts src/component/filters-write.test.ts
git commit -m "feat: maintain filterPostings in the write path; drop per-doc filters rows"
```

---

### Task 5: Wire `search.ts` to page off docKeys (no per-doc filter load)

**Files:**
- Modify: `src/component/search.ts`, `src/component/textSearch.ts`
- Test: `src/component/search.test.ts`, `src/component/facet-search.test.ts`, `src/component/textSearch.test.ts`

**Interfaces:**
- Consumes: `resolveAstToDocIds` now returns `docKeys` (ids empty); `loadDocumentByDocKey` from `docKeys.ts`.
- Produces: `matchTokens` gains an optional trailing param `filterDocKeys?: Set<number>` (after `budget`); when present it filters `passing` by docKey before resolving docIds. Filter-only and filter+facet paths read only a page of documents via docKey.

**Background:** Currently `search.ts` uses `filterIds` (a `Set<string>` of docIds) to build `matchedIds` and intersect with the text path. With postings returning `docKeys`, the filter result is a `Set<number>`. The **filter-only** path (`tokens.length === 0`) works entirely in docKeys and resolves docIds only for the final page. The **text + filter** path intersects on docKey *inside* `matchTokens` (which already works in docKeys until its final Phase B), so `scoreById` comes back already intersected.

- [ ] **Step 1: Add a failing integration test**

In `src/component/search.test.ts`, add (using the file's existing harness/setup helper — match its current pattern for seeding a collection with `filterFields`):

```ts
it("filter-only numeric range returns correct found + page without loading all matches", async () => {
  const t = await seedShop(t_or_setup_helper); // use the file's existing seeding helper
  // seed e.g. 5 docs priced 40,90,110,150,300 (adapt to the file's helper)
  const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "price:[50..150]", perPage: 2, page: 1 });
  expect(r.found).toBe(3); // 90,110,150
  expect(r.hits.length).toBe(2);
});

it("filter + facet intersects via the index", async () => {
  const t = await seedShop();
  const r = await t.query(api.search.search, {
    collection: "shop", q: "", filterBy: "inStock:true", facetBy: ["category"], perPage: 2,
  });
  expect(r.found).toBeGreaterThan(0);
  expect(r.facet_counts[0].field_name).toBe("category");
});
```

> Implementer: adapt the seeding to `search.test.ts`'s existing helpers and field names. The assertions that matter: `found` equals the true matched count, the page has `perPage` hits, and `facet_counts` is populated. If the file lacks a numeric/`inStock` filter field in its seed, extend the seed config — keep `filterFields ⊆ storedFields`.

- [ ] **Step 2: Run to verify it fails (or surfaces the type error)**

Run: `npx vitest run src/component/search.test.ts`
Expected: FAIL — `filterIds` is no longer populated (resolveAstToDocIds returns empty `ids`), so the filter branch produces 0 matches / type errors on `filterIds`.

- [ ] **Step 3: Rework the filter branch in `search.ts`**

Replace the filter-resolution block (lines ~160-177) to keep `docKeys` as the primary handle:

```ts
    let filterDocKeys: Set<number> | null = null;
    let filterComplete = false;
    let filterTruncated = false;
    if (hasFilter) {
      const fieldTypes: Record<string, "string" | "number"> = {};
      for (const f of collection.filterFields ?? []) fieldTypes[f.field] = f.type;
      const resolved = await resolveAstToDocIds(
        ctx, args.collection, parseFilterAst(args.filterBy as string, fieldTypes),
      );
      filterDocKeys = resolved.docKeys;
      filterComplete = resolved.complete;
      filterTruncated = resolved.truncated;
    }
```

Delete the `filterIds` variable. In the working-set builder (lines ~190-232), the two branches that referenced `filterIds` change:

- **Text + filter** (`tokens.length > 0`): intersect on docKey **inside `matchTokens`**, before its docId resolution. `matchTokens` ([textSearch.ts:107-138](src/component/textSearch.ts#L107-L138)) builds `passing: { docKey: number; total: number }[]` and only converts to docIds in its final "Phase B" (`loadDocumentByDocKey` per passing doc). Add an optional `filterDocKeys?: Set<number>` parameter to `matchTokens`; when present, filter `passing` to `passing.filter((p) => filterDocKeys.has(p.docKey))` immediately before Phase B. This is strictly better than filtering after: it (a) needs no docId↔docKey remapping in `search.ts` (the matcher already holds docKeys), and (b) **shrinks** Phase B's `loadDocumentByDocKey` read set to just the docs that survive the filter. In `search.ts`, pass `filterDocKeys ?? undefined` into the `matchTokens(...)` call and DELETE the old `if (filterIds) matchedIds = matchedIds.filter(...)` line — `scoreById` already contains only the intersected docs, so `matchedIds = [...scoreById.keys()]` is correct as-is. The deferred-page text path stays valid (the page load via docId is unchanged). Add a test: text query + filter returns only docs matching BOTH.

- **Filter-only** (`tokens.length === 0`, was `else if (filterIds)`): rewrite to work in docKeys:

```ts
    } else if (filterDocKeys) {
      const keys = [...filterDocKeys];
      const facetsNeedDocs = hasFacets && !(filterDocKeys && filterComplete);
      if (!facetsNeedDocs && !hasCustomOrder) {
        // page-only: map just this page's docKeys -> documents
        const pageStart = (page - 1) * perPage;
        const pageKeys = keys.slice(pageStart, pageStart + perPage);
        const rows = await Promise.all(
          pageKeys.map((k) => loadDocumentByDocKey(ctx, args.collection, k)),
        );
        byId = new Map<string, unknown>();
        matchedIds = [];
        for (const row of rows) {
          if (!row) continue;
          matchedIds.push(row.docId);
          byId.set(row.docId, row.stored);
        }
        // found is the full matched set, not just the page:
        // (set below via matchedKeysCount)
        // To keep matchedIds.length == found for the non-paged code, see Step 4.
      } else {
        const rows = await Promise.all(keys.map((k) => loadDocumentByDocKey(ctx, args.collection, k)));
        byId = new Map<string, unknown>();
        matchedIds = [];
        for (const row of rows) {
          if (!row) continue;
          matchedIds.push(row.docId);
          byId.set(row.docId, row.stored);
        }
      }
    } else if (hasRank) {
```

- [ ] **Step 4: Fix `found` for the page-only filter path**

In the page-only branch above, `matchedIds` holds only the page, so `found = matchedIds.length` (line ~240) would be wrong. Introduce a `filterMatchCount` that captures the true size:

After resolving the filter, set `const filterMatchCount = filterDocKeys ? filterDocKeys.size : null;`. Then change the `found` assignment:

```ts
    let found = filterMatchCount ?? matchedIds.length;
```

And keep the existing `found_approximate = filterTruncated || windowTruncated`. The facet-intersection block (lines ~300-313) currently keys off `filterDocKeys` — it stays valid since `filterDocKeys` is still a `Set<number>`. The `tokens.length === 0 && filterDocKeys && filterComplete` guard is unchanged.

> Implementer: this is the subtle task. The page-only branch must (a) report `found` = full match count, (b) return only `perPage` hits, (c) keep facet intersection working off `filterDocKeys`. The `facetIds = matchedIds` line (~263) is only used for the load-and-tally fallback (when `!filterComplete`); in that fallback you loaded all matched docs (the `else` branch), so `matchedIds` is the full set and tally works. Verify both the complete (index-intersection) and incomplete (load-and-tally) facet paths with a test.

- [ ] **Step 5: Add `loadDocumentByDocKey` import**

```ts
import { loadDocumentByDocKey } from "./docKeys";
```

- [ ] **Step 6: Add the docKey intersection to `matchTokens` (text + filter path)**

In `src/component/textSearch.ts`, add an optional trailing param to `matchTokens` and filter `passing` before Phase B:

```ts
export async function matchTokens(
  ctx: QueryCtx,
  collection: string,
  tokens: string[],
  queryBy: string[] | undefined,
  budget: number = POSTINGS_BUDGET,
  filterDocKeys?: Set<number>,
): Promise<{ ... }> {
```

Then, right before "Phase B — resolve docIds" (the `const docs = await Promise.all(passing.map(...))` line, ~line 131), insert:

```ts
  const finalPassing = filterDocKeys ? passing.filter((p) => filterDocKeys.has(p.docKey)) : passing;
```

and change Phase B to iterate `finalPassing` instead of `passing` (both the `Promise.all(finalPassing.map(...))` and the `for` loop over `finalPassing.length`).

In `src/component/search.ts`, change the text-path call (line ~192) to:

```ts
      const m = await matchTokens(ctx, args.collection, tokens, args.queryBy, undefined, filterDocKeys ?? undefined);
```

and DELETE the line `if (filterIds) matchedIds = matchedIds.filter((id) => filterIds!.has(id));` — `scoreById` is now already intersected.

Add a test in `src/component/textSearch.test.ts` (mirror its existing harness): seed two docs that both match a term but only one matches a filter docKey; call `matchTokens(..., new Set([thatDocKey]))`; assert `scoreById` has exactly the one docId.

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run src/component/search.test.ts src/component/facet-search.test.ts src/component/textSearch.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/component/search.ts src/component/textSearch.ts src/component/search.test.ts src/component/facet-search.test.ts src/component/textSearch.test.ts
git commit -m "feat: page filter results off docKeys via the bucketed index"
```

---

### Task 6: Migration guard — report `complete: false` for un-backfilled collections

**Files:**
- Modify: `src/component/filter.ts`, `src/component/search.ts`
- Test: `src/component/sync-reindex.test.ts`

**Interfaces:**
- Consumes: collection `pendingFields` (already on the schema, set during structural-field changes).
- Produces: when a collection has pending filter fields (mid-migration), `resolveAstToDocIds` returns `complete: false` so `search.ts` falls back to load-and-tally for facets (never returns wrong counts).

**Rationale:** With the hard cutover, an existing collection seeded before this change has NO `filterPostings` rows until `reindex` replays it. A filter query against it would return 0 docKeys — silently wrong. Guard it: if the collection's `pendingFields` is non-empty (the existing reindex/backfill signal), mark filter results incomplete and have `search.ts` treat an incomplete filter as a signal to load-and-tally rather than trust the index. Since a fresh post-change collection has `filterPostings` from the first upsert, this only affects in-flight migrations.

- [ ] **Step 1: Write the failing test**

In `src/component/sync-reindex.test.ts`, add a test that simulates an un-backfilled collection: insert `documents` rows directly (bypassing the write path so no `filterPostings` exist), set `pendingFields`, and assert a filter query reports incomplete and still returns correct counts via fallback. Match the file's existing harness. Skeleton:

```ts
it("filter on a not-yet-reindexed collection reports incomplete and falls back", async () => {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  // create collection with a filter field, then mark a pending field to emulate mid-migration
  // insert a documents row WITHOUT postings, then query and assert complete === false
  // (exact seeding mirrors the other tests in this file)
});
```

> Implementer: model this on how `sync-reindex.test.ts` already constructs pending/backfill states. The assertion: `resolveAstToDocIds(...).complete === false` when `pendingFields` includes a filter field.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/component/sync-reindex.test.ts`
Expected: FAIL — `complete` is hard-coded `true`.

- [ ] **Step 3: Thread the pending signal into `resolveAstToDocIds`**

`resolveAstToDocIds` does not currently load the collection. Add an optional `pendingFilterFields?: Set<string>` parameter (defaulted empty) and, in each leaf, set `complete: !pendingFilterFields.has(field)`. Propagate `complete` through AND/OR/inSet (already `a.complete && b.complete`). In `search.ts`, compute the set from `collection.pendingFields` filtered to declared `filterFields` and pass it in.

```ts
// filter.ts leaf, e.g. strKeys:
function keysResult(r, complete) { return { ids: new Set(), docKeys: new Set(r.docKeys), truncated: r.truncated, complete }; }
```

```ts
// search.ts, where it resolves:
const pendingFilter = new Set(
  (collection.pendingFields ?? []).filter((f) =>
    (collection.filterFields ?? []).some((ff) => ff.field === f)),
);
const resolved = await resolveAstToDocIds(ctx, args.collection, ast, FILTER_RESULT_BUDGET, pendingFilter);
```

When `!filterComplete`, force the load-and-tally facet path (the existing `tokens.length === 0 && filterDocKeys && filterComplete` guard already does this — leaving it as-is means an incomplete result skips the index intersection and tallies from loaded docs).

> Note: even with the guard, a filter query against a fully un-backfilled collection (zero postings) returns an empty docKey set and thus `found: 0`. That is the documented migration window behavior, identical to `facetPostings`' contract: **run the app's `reindex` mutation to backfill before relying on filter results.** State this in the comment.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/component/sync-reindex.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/component/filter.ts src/component/search.ts src/component/sync-reindex.test.ts
git commit -m "feat: mark filter results incomplete during reindex backfill"
```

---

### Task 7: Deletion + index-health for `filterPostings`

**Files:**
- Modify: `src/component/collections.ts`, `src/component/stats.ts`, `src/component/schema.ts` (stats validator), `src/component/facetPostings.ts` (doc comment)
- Test: `src/component/collections.test.ts`, plus a stats assertion (in the file that tests `stats`)

**Interfaces:**
- Consumes: the `filterPostings` table.
- Produces: `deleteCollection` tears down `filterPostings`; `hasCollectionIndexRows` checks it; `stats` reports `filterPostings` health.

- [ ] **Step 1: Write failing tests**

In `src/component/collections.test.ts`, extend the existing "deleteCollection removes all index rows" test (or add one) to assert no `filterPostings` rows remain after deletion, and that `hasCollectionIndexRows` (via `blockIfDeletionInProgress` throwing) accounts for `filterPostings`. Mirror how the test already checks `facetPostings`.

Add to the stats test: after seeding a collection with a filter field, `stats` returns a `filterPostings` array whose `totalDocKeys` equals the number of seeded docs for that field.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/component/collections.test.ts`
Expected: FAIL — deletion batch and health check don't touch `filterPostings`; stats has no `filterPostings` field.

- [ ] **Step 3: Replace `filters` with `filterPostings` in `collections.ts`**

In `hasCollectionIndexRows` (lines ~62-65), replace the `filters`/`by_doc` query with:

```ts
    ctx.db
      .query("filterPostings")
      .withIndex("by_str", (q) => q.eq("collection", name))
      .first(),
```

> Note: `by_str` index prefix is `[collection, field, strVal, bucket]`; `eq("collection", name)` alone is a valid prefix scan and matches string rows. Numeric rows lack `strVal`; add a second probe on `by_num` with `eq("collection", name)` and OR the two results, so a collection with only numeric filters is also detected. Update the `Promise.all` destructuring and the final `return !!(...)` accordingly (rename the `filter` slot to `filterStr`/`filterNum`).

In `deleteCollectionRowsBatch` (lines ~143-150), replace the `filters` block with a `filterPostings` block (delete by `by_str` prefix; since deletion batches by `take(batchSize)` and returns `false` while rows remain, one index covering both row kinds is needed — use `by_num`? No: `by_str` won't see numeric-only rows). **Cleanest:** add a third index `by_collection` on `["collection"]` to `filterPostings` for prefix enumeration during teardown/health, OR iterate both `by_str` and `by_num` in the batch. Add the `by_collection` index — it is the simplest and matches no existing pattern cost:

In `schema.ts` `filterPostings`, add `.index("by_collection", ["collection"])`. Then in `deleteCollectionRowsBatch`:

```ts
  const filterPostings = await ctx.db
    .query("filterPostings")
    .withIndex("by_collection", (q) => q.eq("collection", name))
    .take(batchSize);
  if (filterPostings.length > 0) {
    for (const r of filterPostings) await ctx.db.delete(r._id);
    return false;
  }
```

And simplify `hasCollectionIndexRows` to use `by_collection` too (one probe).

- [ ] **Step 4: Add `filterPostings` health to `stats.ts` + validator**

In `schema.ts` `statsResultValidator`, add after `facetPostings`:

```ts
  filterPostings: v.array(
    v.object({
      field: v.string(),
      totalDocKeys: v.number(),
      distinctOrBuckets: v.number(),
    }),
  ),
```

In `stats.ts`, after the `facetPostings` block, add a `filterPostings` block: for each declared `filterFields` field, scan `by_collection` (or `by_str`/`by_num`) rows for that field, sum `docKeys.length + (entries?.length ?? 0)` into `totalDocKeys`, and count rows into `distinctOrBuckets`. Bound the read with a budget constant `FILTER_POSTINGS_READ_BUDGET = 500` like the facet one. Return it in the result object.

- [ ] **Step 5: Update the backfill-contract comment in `facetPostings.ts`**

Change the comment block (lines ~3-14) to read that a replayed upsert rebuilds `filterPostings` (not `filters`), since `filters` no longer exists.

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/component/collections.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/component/collections.ts src/component/stats.ts src/component/schema.ts src/component/facetPostings.ts src/component/collections.test.ts
git commit -m "feat: tear down + health-check filterPostings; drop filters from deletion"
```

---

### Task 8: Full component test sweep + remove dangling `filters` references

**Files:**
- Modify: any remaining test or source file still referencing the `filters` table.

- [ ] **Step 1: Grep for stragglers**

Run: `grep -rn '"filters"\|query("filters")\|insert("filters"' src/component/`
Expected: ZERO hits in non-deleted code. Fix any remaining `.test.ts` that seeds/reads `filters` directly (e.g. `filter.test.ts`) by reseeding via the write path or `filterPostings` helpers.

- [ ] **Step 2: Run the full component suite**

Run: `npm test`
Expected: PASS, no type errors. (`--typecheck` is on, so a leftover reference to the removed `filters` table fails compilation.)

- [ ] **Step 3: Commit**

```bash
git add -A src/component
git commit -m "test: migrate remaining filters-table tests to filterPostings"
```

---

### Task 9: Example app + benchmark validation

**Files:**
- Modify (if needed): `example/convex/_generated/*` (regenerated), no `products.ts` logic change expected.
- Verify: `example/convex/products.ts` benchmark.

**Background:** `products.ts` never touches the `filters` table directly — it goes through `search.upsertMany`/`search.search`. So no app logic changes. But the component's generated API types changed (schema), so regenerate.

- [ ] **Step 1: Regenerate component API types for the example**

Run: `npx convex codegen` (from repo root, or `cd example && npx convex codegen`). If the repo uses a build step for `dist`, run `npm run build` (check `package.json` scripts; the recent commit `eea24b6 chore: regenerate component API types` shows this is a normal step).

- [ ] **Step 2: Typecheck the example**

Run: `cd example && npx tsc --noEmit -p tsconfig.json` (or the repo's example test). Adapt to the example's actual typecheck command if different.
Expected: PASS.

- [ ] **Step 3: Run the example's own tests**

Run: `npx vitest run example/convex/products.test.ts`
Expected: PASS.

- [ ] **Step 4: (Manual, optional) Re-run the benchmark to confirm the fix**

If a deployment is available: seed 5000 docs (`startSeed`), run the `benchmark` action, and confirm `numeric range filter` and `boolean+facet` drop from ~1188ms/~2189ms to the same order as the other paths (tens-to-low-hundreds of ms). Record the before/after numbers in the PR description. This is the real-world proof the read-amplification is gone (reads drop from ~995/~4000 rows to ~16/~63 bucket rows).

- [ ] **Step 5: Commit**

```bash
git add example dist
git commit -m "chore: regenerate component API types for filterPostings"
```

---

## Self-Review

**Spec coverage:**
- Replace `filters` with `filterPostings` → Tasks 1, 2 (schema/postings), 4 (write), 5 (read), 7 (deletion), 8 (cleanup). ✓
- Equality + numeric range served from the index → Task 1 (string), Task 2 (numeric range), Task 3 (resolver). ✓
- Backfill via existing reindex/replay → Task 6 (incomplete guard) + Task 9 (example already drives reindex). The write path builds postings on every upsert (Task 4), so `reindex`'s replay backfills with no new code. ✓
- Health/stats parity → Task 7. ✓
- Benchmark validation → Task 9. ✓

**Placeholder scan:** The two intentionally-delegated spots are the strict-comparator boundary handling (Task 3, with a concrete recommended alternative + required test) and the `search.test.ts`/`sync-reindex.test.ts` seeding (Tasks 5, 6, 7 — delegated to the file's existing helpers because their exact shape varies; each names the precise assertions that must hold). All code steps show real code.

**Type consistency:** `ResolveResult` shape is constant across Tasks 3/5/6 (`ids` empty, `docKeys` populated). `FILTER_CHUNK_SIZE`/`NUMERIC_BUCKET_WIDTH` exported once (Task 1) and referenced by name. `readNumericRangeDocKeys` signature: if the implementer adopts the strict-comparator flag variant in Task 3, the signature change `(lo, hi, loInclusive, hiInclusive, budget)` must be applied in Task 2's function and all Task 3 callers together — flagged in Task 3. `clearDoc` gains a `filterFields` param (Task 4) — both call sites updated in the same task.

**Known open risk for the implementer:** Task 5 is the highest-risk task. The text+filter intersection is grounded: `matchTokens` already works in docKeys until its final Phase B, so it takes an optional `filterDocKeys` and filters `passing` before resolving docIds (Step 6). The remaining subtlety is the **page-only `found` accounting** (Step 4): in the page-only filter branch `matchedIds` holds only the page, so `found` must come from `filterDocKeys.size` (captured as `filterMatchCount`), not `matchedIds.length`. Confirm BOTH facet paths — index-intersection (`filterComplete`) and load-and-tally (`!filterComplete`) — with `facet-search.test.ts` before claiming Task 5 done.

---

## Execution Handoff

(Filled in by the orchestrator after plan approval.)
