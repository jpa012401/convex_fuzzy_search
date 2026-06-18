# Inverted Facet Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute filtered facet counts by intersecting sorted-docKey posting lists instead of loading every matched document — removing the 4096-read throw and 8.5s latency on the `filter + facet` query path.

**Architecture:** Add an inverted `facetPostings` index (`(field,value) → docKeys`, fill-based 64-buckets) maintained on write like term postings. Add `docKey` to `filters` so the filter resolves directly into docKey space. The filtered-facet read path intersects the filter docKey set against each facet value's posting list (set membership) — no `loadDocs`. A backfill populates both new structures for existing collections, with a pending flag so a partial index never returns wrong counts.

**Tech Stack:** TypeScript, Convex components, `@convex-dev/aggregate`, vitest + convex-test (`npm test` = `vitest run --typecheck`). Cloud-dev deployment `perfect-lion-433` (`--deployment dev`) for the benchmark.

## Global Constraints

- Full suite green after every task: `npm test` ≥ 212 passing, 0 type errors. `npm run typecheck` clean before merge.
- **No wrong counts, ever.** While a collection's facet-posting index is incomplete (pre-backfill), the read path MUST fall back to the existing load-and-tally rather than return under-counts.
- `FACET_CHUNK_SIZE = 64`, its own constant (do not couple to `POSTING_CHUNK_SIZE`).
- **Fill-based bucketing:** a docKey appends to the current tail bucket (highest `bucket`) for its `(field,value)`; open `tail+1` only when the tail holds 64. Removal deletes the docKey from whichever bucket holds it; an emptied bucket row is deleted; no rebalancing.
- Intersection treats a value's docKeys as a **set** (cross-bucket order is not guaranteed).
- The forward `facetCounts` table stays and is still maintained (serves the unfiltered browse-facet path). This plan only changes the *filtered* path.
- Cloud deploys are `--deployment dev` only; never `--prod`; no re-seed.
- Spec: `docs/superpowers/specs/2026-06-18-inverted-facet-index-design.md`.

---

### Task 0: Create the working branch

**Files:** none (git)

- [ ] **Step 1: Branch off main**

```bash
git checkout main
git checkout -b feat/inverted-facet-index
git status
```
Expected: `On branch feat/inverted-facet-index`, clean tree.

---

### Task 1: Add `docKey` to the `filters` table + write path

**Files:**
- Modify: `src/component/schema.ts` (filters table)
- Modify: `src/component/write.ts:119-140` (filters insert)
- Test: `src/component/filters-write.test.ts`

**Interfaces:**
- Consumes: `upsertInternal` already computes `docKey` (via `ensureDocKey`) before the filters loop.
- Produces: `filters` rows now carry `docKey: number`.

- [ ] **Step 1: Add the field to the schema**

In `src/component/schema.ts`, the `filters` table currently is:

```ts
  filters: defineTable({
    collection: v.string(),
    field: v.string(),
    docId: v.string(),
    strVal: v.optional(v.string()),
    numVal: v.optional(v.number()),
  })
    .index("by_str", ["collection", "field", "strVal"])
    .index("by_num", ["collection", "field", "numVal"])
    .index("by_doc", ["collection", "docId"]),
```

Add `docKey` (optional — existing rows lack it until backfill):

```ts
  filters: defineTable({
    collection: v.string(),
    field: v.string(),
    docId: v.string(),
    docKey: v.optional(v.number()),
    strVal: v.optional(v.string()),
    numVal: v.optional(v.number()),
  })
    .index("by_str", ["collection", "field", "strVal"])
    .index("by_num", ["collection", "field", "numVal"])
    .index("by_doc", ["collection", "docId"]),
```

- [ ] **Step 2: Write `docKey` on insert**

In `src/component/write.ts`, the filters loop (lines ~119-140) inserts `{collection, field, docId, strVal|numVal}`. Add `docKey` to both inserts. The `docKey` variable already exists in `upsertInternal` scope (computed at the top via `ensureDocKey`). Change both `ctx.db.insert("filters", {...})` calls to include `docKey`:

```ts
  for (const f of col.filterFields ?? []) {
    const value = doc[f.field];
    if (value === undefined || value === null) continue;
    if (f.type === "string") {
      await ctx.db.insert("filters", {
        collection,
        field: f.field,
        docId: id,
        docKey,
        strVal: String(value),
      });
    } else {
      const num = Number(value);
      if (!Number.isNaN(num)) {
        await ctx.db.insert("filters", {
          collection,
          field: f.field,
          docId: id,
          docKey,
          numVal: num,
        });
      }
    }
  }
```

- [ ] **Step 3: Add a test asserting docKey is written**

Append to `src/component/filters-write.test.ts` (mirror its existing setup; it already creates a collection with filterFields and upserts a doc). Add inside its describe block:

```ts
  it("writes docKey on filter rows", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "fk",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }],
    });
    await t.mutation(api.write.upsert, { collection: "fk", id: "x1", doc: { name: "a", brand: "Acme" } });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("filters").withIndex("by_doc", (q) => q.eq("collection", "fk").eq("docId", "x1")).collect(),
    );
    expect(rows.length).toBe(1);
    expect(typeof rows[0].docKey).toBe("number");
  });
```

(If `filters-write.test.ts` lacks the `convexTest`/`registerAggregate`/`schema`/`api` imports, add them — copy the import block from `src/component/write.test.ts`.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run --typecheck src/component/filters-write.test.ts src/component/write.test.ts`
Expected: pass, 0 type errors.

Run: `npm test`
Expected: ≥ 213 passing (212 + 1 new), 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/component/schema.ts src/component/write.ts src/component/filters-write.test.ts
git commit -m "feat: store docKey on filters rows for docKey-space resolution"
```

---

### Task 2: Resolve filters into docKey space

**Files:**
- Modify: `src/component/filter.ts:195-238` (ResolveResult + helpers)
- Modify: `src/component/search.ts` (consume docKey set; keep docId usage working)
- Test: `src/component/filter-resolve.test.ts`

**Interfaces:**
- Consumes: `filters` rows now have `docKey?: number` (Task 1).
- Produces: `resolveAstToDocIds` additionally returns a `docKeys: Set<number>` alongside the existing `ids: Set<string>`, and a `complete: boolean` (false if any consumed row lacked `docKey` — i.e. pre-backfill). Signature: `{ ids: Set<string>; docKeys: Set<number>; truncated: boolean; complete: boolean }`.

- [ ] **Step 1: Extend ResolveResult to carry docKeys + completeness**

In `src/component/filter.ts`, change `ResolveResult` and `rowsToResult`:

```ts
type ResolveResult = { ids: Set<string>; docKeys: Set<number>; truncated: boolean; complete: boolean };

function rowsToResult(rows: { docId: string; docKey?: number }[], budget: number): ResolveResult {
  const kept = rows.slice(0, budget);
  const docKeys = new Set<number>();
  let complete = true;
  for (const r of kept) {
    if (r.docKey === undefined) { complete = false; continue; }
    docKeys.add(r.docKey);
  }
  return {
    ids: new Set(kept.map((r) => r.docId)),
    docKeys,
    truncated: rows.length > budget,
    complete,
  };
}
```

- [ ] **Step 2: Thread docKeys + complete through the combinators**

In `resolveAstToDocIds`, the `and`/`or`/`inSet` cases combine `ids`. Combine `docKeys` and `complete` in parallel. Replace the `and`, `or`, and `inSet` cases:

```ts
    case "and": {
      const a = await resolveAstToDocIds(ctx, collection, ast.left, budget);
      const b = await resolveAstToDocIds(ctx, collection, ast.right, budget);
      const [small, big] = a.ids.size <= b.ids.size ? [a.ids, b.ids] : [b.ids, a.ids];
      const out = new Set<string>();
      for (const id of small) if (big.has(id)) out.add(id);
      const [smallK, bigK] = a.docKeys.size <= b.docKeys.size ? [a.docKeys, b.docKeys] : [b.docKeys, a.docKeys];
      const outK = new Set<number>();
      for (const k of smallK) if (bigK.has(k)) outK.add(k);
      return { ids: out, docKeys: outK, truncated: a.truncated || b.truncated, complete: a.complete && b.complete };
    }
    case "or": {
      const a = await resolveAstToDocIds(ctx, collection, ast.left, budget);
      const b = await resolveAstToDocIds(ctx, collection, ast.right, budget);
      for (const id of b.ids) {
        if (a.ids.size >= budget) return { ids: a.ids, docKeys: a.docKeys, truncated: true, complete: a.complete && b.complete };
        a.ids.add(id);
      }
      for (const k of b.docKeys) a.docKeys.add(k);
      return { ids: a.ids, docKeys: a.docKeys, truncated: a.truncated || b.truncated, complete: a.complete && b.complete };
    }
    case "inSet": {
      const out = new Set<string>();
      const outK = new Set<number>();
      let truncated = false;
      let complete = true;
      for (const v of ast.values) {
        const result = ast.type === "number"
          ? await numEqIds(ctx, collection, ast.field, Number(v), budget)
          : await strIds(ctx, collection, ast.field, v, budget);
        truncated ||= result.truncated;
        complete &&= result.complete;
        for (const id of result.ids) {
          if (out.size >= budget) return { ids: out, docKeys: outK, truncated: true, complete };
          out.add(id);
        }
        for (const k of result.docKeys) outK.add(k);
      }
      return { ids: out, docKeys: outK, truncated, complete };
    }
```

(The `exact`, `cmp`, `range` cases delegate to `strIds`/`numEqIds`/`numCmpIds`/`numRangeIds`, which now return the extended shape via `rowsToResult` — no change needed there. Note `numCmpIds`/`numRangeIds` already `.filter((r) => r.numVal !== undefined)` before `rowsToResult`; that still passes rows with `docKey`.)

- [ ] **Step 3: Update search.ts consumer**

In `src/component/search.ts`, `resolveAstToDocIds` is destructured as `{ ids, truncated }` (around line 170). Update to also capture the new fields and store them for the read path. Find:

```ts
      filterIds = resolved.ids;
      filterTruncated = resolved.truncated;
```

and add (declare `filterDocKeys` / `filterComplete` near `filterIds`):

```ts
      filterIds = resolved.ids;
      filterDocKeys = resolved.docKeys;
      filterComplete = resolved.complete;
      filterTruncated = resolved.truncated;
```

Declare alongside `let filterIds: Set<string> | null = null;`:

```ts
    let filterDocKeys: Set<number> | null = null;
    let filterComplete = false;
```

- [ ] **Step 4: Test docKey resolution**

Append to `src/component/filter-resolve.test.ts` (mirror its setup):

```ts
  it("resolves a filter to docKeys and reports complete", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "fr",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }],
    });
    await t.mutation(api.write.upsert, { collection: "fr", id: "a", doc: { name: "x", brand: "Acme" } });
    await t.mutation(api.write.upsert, { collection: "fr", id: "b", doc: { name: "y", brand: "Acme" } });
    const res = await t.run(async (ctx) => {
      const { resolveAstToDocIds, parseFilterAst } = await import("./filter");
      return resolveAstToDocIds(ctx, "fr", parseFilterAst("brand:Acme", { brand: "string" }));
    });
    expect(res.docKeys.size).toBe(2);
    expect(res.complete).toBe(true);
    expect(res.ids.size).toBe(2);
  });
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run --typecheck src/component/filter-resolve.test.ts src/component/filter.test.ts src/component/search.test.ts`
Expected: pass, 0 type errors.

Run: `npm test`
Expected: ≥ 214 passing, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/component/filter.ts src/component/search.ts src/component/filter-resolve.test.ts
git commit -m "feat: resolve filters into docKey space with completeness flag"
```

---

### Task 3: `facetPostings` schema + module (fill-based)

**Files:**
- Modify: `src/component/schema.ts` (new table)
- Create: `src/component/facetPostings.ts`
- Test: `src/component/facetPostings.test.ts`

**Interfaces:**
- Produces:
  - `FACET_CHUNK_SIZE = 64`
  - `addFacetPostings(ctx, collection, docKey, facets: { field: string; value: string }[]): Promise<void>`
  - `removeFacetPostings(ctx, collection, docKey, facets: { field: string; value: string }[]): Promise<void>`
  - `readFacetPostingDocKeys(ctx, collection, field, value): Promise<Set<number>>`

- [ ] **Step 1: Add the table to schema**

In `src/component/schema.ts`, after the `facetCounts` table, add:

```ts
  facetPostings: defineTable({
    collection: v.string(),
    field: v.string(),
    value: v.string(),
    bucket: v.number(),
    docKeys: v.array(v.number()),
  })
    .index("by_collection_field_value", ["collection", "field", "value"])
    .index("by_collection_field_value_bucket", ["collection", "field", "value", "bucket"]),
```

- [ ] **Step 2: Write the failing test**

Create `src/component/facetPostings.test.ts`:

```ts
/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import {
  FACET_CHUNK_SIZE,
  addFacetPostings,
  removeFacetPostings,
  readFacetPostingDocKeys,
} from "./facetPostings";

const modules = import.meta.glob("./**/*.ts");

describe("facetPostings (fill-based)", () => {
  it("fills the tail bucket before opening a new one", async () => {
    const t = convexTest(schema, modules);
    const N = FACET_CHUNK_SIZE + 5; // forces a 2nd bucket
    await t.run(async (ctx) => {
      for (let k = 0; k < N; k++) {
        await addFacetPostings(ctx, "c", k, [{ field: "category", value: "X" }]);
      }
    });
    const { buckets, all } = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("facetPostings")
        .withIndex("by_collection_field_value", (q) =>
          q.eq("collection", "c").eq("field", "category").eq("value", "X"),
        )
        .collect();
      const all = await readFacetPostingDocKeys(ctx, "c", "category", "X");
      return { buckets: rows.map((r) => r.docKeys.length).sort((a, b) => b - a), all: [...all].sort((a, b) => a - b) };
    });
    expect(buckets).toEqual([FACET_CHUNK_SIZE, 5]); // first full, tail holds remainder
    expect(all.length).toBe(N);
    expect(all).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it("dedups a repeated docKey", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await addFacetPostings(ctx, "c", 7, [{ field: "f", value: "v" }]);
      await addFacetPostings(ctx, "c", 7, [{ field: "f", value: "v" }]);
    });
    const all = await t.run((ctx) => readFacetPostingDocKeys(ctx, "c", "f", "v"));
    expect([...all]).toEqual([7]);
  });

  it("removes a docKey and deletes an emptied bucket", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await addFacetPostings(ctx, "c", 1, [{ field: "f", value: "v" }]);
      await removeFacetPostings(ctx, "c", 1, [{ field: "f", value: "v" }]);
    });
    const { all, rowCount } = await t.run(async (ctx) => {
      const all = await readFacetPostingDocKeys(ctx, "c", "f", "v");
      const rows = await ctx.db
        .query("facetPostings")
        .withIndex("by_collection_field_value", (q) => q.eq("collection", "c").eq("field", "f").eq("value", "v"))
        .collect();
      return { all: [...all], rowCount: rows.length };
    });
    expect(all).toEqual([]);
    expect(rowCount).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to verify failure**

Run: `npx vitest run src/component/facetPostings.test.ts`
Expected: FAIL (module `./facetPostings` not found).

- [ ] **Step 4: Implement the module**

Create `src/component/facetPostings.ts`:

```ts
import type { MutationCtx, QueryCtx } from "./_generated/server";

// Fill-based inverted facet index: (field, value) -> sorted docKeys, packed into
// buckets of FACET_CHUNK_SIZE. A docKey appends to the current tail bucket
// (highest `bucket`); a new bucket opens only when the tail is full. Removal
// deletes the docKey from whichever bucket holds it; an emptied bucket is
// deleted. No rebalancing — density is a write-time invariant, not maintained.
export const FACET_CHUNK_SIZE = 64;

type Facet = { field: string; value: string };

async function tailBucket(
  ctx: QueryCtx,
  collection: string,
  field: string,
  value: string,
) {
  return await ctx.db
    .query("facetPostings")
    .withIndex("by_collection_field_value_bucket", (q) =>
      q.eq("collection", collection).eq("field", field).eq("value", value),
    )
    .order("desc")
    .first();
}

function insertSorted(arr: number[], x: number): number[] {
  if (arr.includes(x)) return arr;
  const out = [...arr, x];
  out.sort((a, b) => a - b);
  return out;
}

export async function addFacetPostings(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  facets: Facet[],
): Promise<void> {
  for (const { field, value } of facets) {
    const tail = await tailBucket(ctx, collection, field, value);
    if (!tail) {
      await ctx.db.insert("facetPostings", { collection, field, value, bucket: 0, docKeys: [docKey] });
      continue;
    }
    if (tail.docKeys.includes(docKey)) continue; // already present somewhere is checked per-bucket; see remove note
    if (tail.docKeys.length < FACET_CHUNK_SIZE) {
      await ctx.db.patch(tail._id, { docKeys: insertSorted(tail.docKeys, docKey) });
    } else {
      await ctx.db.insert("facetPostings", { collection, field, value, bucket: tail.bucket + 1, docKeys: [docKey] });
    }
  }
}

export async function removeFacetPostings(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  facets: Facet[],
): Promise<void> {
  for (const { field, value } of facets) {
    const rows = await ctx.db
      .query("facetPostings")
      .withIndex("by_collection_field_value", (q) =>
        q.eq("collection", collection).eq("field", field).eq("value", value),
      )
      .collect();
    for (const row of rows) {
      if (!row.docKeys.includes(docKey)) continue;
      const next = row.docKeys.filter((k) => k !== docKey);
      if (next.length === 0) await ctx.db.delete(row._id);
      else await ctx.db.patch(row._id, { docKeys: next });
    }
  }
}

export async function readFacetPostingDocKeys(
  ctx: QueryCtx,
  collection: string,
  field: string,
  value: string,
): Promise<Set<number>> {
  const out = new Set<number>();
  const rows = await ctx.db
    .query("facetPostings")
    .withIndex("by_collection_field_value", (q) =>
      q.eq("collection", collection).eq("field", field).eq("value", value),
    )
    .collect();
  for (const row of rows) for (const k of row.docKeys) out.add(k);
  return out;
}
```

> Dedup note: `addFacetPostings` checks the *tail* for the docKey. Because a doc
> is fully removed (`removeFacetPostings` over all buckets) before re-add in the
> upsert replace path, a docKey cannot already live in a non-tail bucket at add
> time. The tail check prevents a same-tail duplicate. `readFacetPostingDocKeys`
> returns a Set, so any residual duplicate is harmless to counts.

- [ ] **Step 5: Run tests**

Run: `npx vitest run --typecheck src/component/facetPostings.test.ts`
Expected: 3 pass, 0 type errors.

Run: `npm test`
Expected: ≥ 217 passing (214 + 3), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/component/schema.ts src/component/facetPostings.ts src/component/facetPostings.test.ts
git commit -m "feat: add fill-based inverted facetPostings index module"
```

---

### Task 4: Maintain `facetPostings` on the write path

**Files:**
- Modify: `src/component/write.ts` (upsertInternal facet loop + clearDoc)
- Test: `src/component/facets-write.test.ts`

**Interfaces:**
- Consumes: `addFacetPostings`/`removeFacetPostings` (Task 3); `incrementFacet`/`decrementFacet` (existing).
- Produces: every facet write maintains BOTH the forward `facetCounts` and the inverted `facetPostings`.

- [ ] **Step 1: Add postings on upsert**

In `src/component/write.ts`, import at top alongside the facetCounts import:

```ts
import { addFacetPostings, removeFacetPostings } from "./facetPostings";
```

In `upsertInternal`, the facet loop currently calls only `incrementFacet`. Replace it to also collect `(field,value)` pairs and add postings (the `docKey` is in scope):

```ts
  const facetPairs: { field: string; value: string }[] = [];
  for (const field of col.facetFields ?? []) {
    const raw = doc[field];
    if (raw === undefined || raw === null) continue;
    const value = String(raw);
    await incrementFacet(ctx, collection, field, value);
    facetPairs.push({ field, value });
  }
  await addFacetPostings(ctx, collection, docKey, facetPairs);
```

- [ ] **Step 2: Remove postings in clearDoc**

In `clearDoc` (the function that tears a doc's index rows down before re-index/delete), the facet decrement loop reads `stored[field]` for each facet field. Collect those pairs and call `removeFacetPostings` with the doc's `docKey`. `clearDoc` has `existing` (the document row, which carries `docKey`). Find the facet decrement loop:

```ts
    for (const field of facetFields) {
      const raw = stored[field];
      if (raw === undefined || raw === null) continue;
      await decrementFacet(ctx, collection, field, String(raw));
    }
```

Replace with:

```ts
    const facetPairs: { field: string; value: string }[] = [];
    for (const field of facetFields) {
      const raw = stored[field];
      if (raw === undefined || raw === null) continue;
      const value = String(raw);
      await decrementFacet(ctx, collection, field, value);
      facetPairs.push({ field, value });
    }
    await removeFacetPostings(ctx, collection, existing.docKey, facetPairs);
```

(`existing` is the documents row in scope inside the `if (existing) { ... }` block where the facet decrement loop lives; `existing.docKey` is its docKey.)

- [ ] **Step 3: Test write/delete maintains postings**

Append to `src/component/facets-write.test.ts`:

```ts
  it("maintains facetPostings on upsert and delete", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "fp",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }],
      facetFields: ["brand"],
    });
    await t.mutation(api.write.upsert, { collection: "fp", id: "a", doc: { name: "x", brand: "Acme" } });
    const after = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("facetPostings")
        .withIndex("by_collection_field_value", (q) => q.eq("collection", "fp").eq("field", "brand").eq("value", "Acme"))
        .collect();
      return rows.flatMap((r) => r.docKeys);
    });
    expect(after.length).toBe(1);
    await t.mutation(api.write.delete, { collection: "fp", id: "a" });
    const gone = await t.run(async (ctx) =>
      ctx.db.query("facetPostings").withIndex("by_collection_field_value", (q) => q.eq("collection", "fp").eq("field", "brand").eq("value", "Acme")).collect(),
    );
    expect(gone.length).toBe(0); // emptied bucket deleted
  });
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run --typecheck src/component/facets-write.test.ts src/component/write.test.ts`
Expected: pass, 0 type errors.

Run: `npm test`
Expected: ≥ 218 passing, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/component/write.ts src/component/facets-write.test.ts
git commit -m "feat: maintain facetPostings on the write path"
```

---

### Task 5: Lifecycle — teardown + index-health for `facetPostings`

**Files:**
- Modify: `src/component/collections.ts` (`hasCollectionIndexRows`, `deleteCollectionRowsBatch`)
- Test: `src/component/collections.test.ts`

**Interfaces:**
- Consumes: `facetPostings` table (Task 3), `by_collection_field_value` index.
- Produces: `deleteCollection` removes all `facetPostings`; an in-progress deletion is detected by their presence.

- [ ] **Step 1: Include facetPostings in `hasCollectionIndexRows`**

In `src/component/collections.ts`, `hasCollectionIndexRows` does `Promise.all([...])` over the index tables and returns a boolean OR. Add a `facetPosting` probe. The `facetPostings` `by_collection_field_value` index has prefix `[collection]`, so `eq("collection", name)` enumerates the collection's rows. Add to the `Promise.all` array:

```ts
    ctx.db
      .query("facetPostings")
      .withIndex("by_collection_field_value", (q) => q.eq("collection", name))
      .first(),
```

Bind it in the destructure (add `facetPosting` to the list) and include it in the final OR:

```ts
  return !!(doc || docTerm || postingChunk || docKeyCounter || term || trigram || filter || facet || facetPosting);
```

- [ ] **Step 2: Delete facetPostings in the teardown batch**

In `deleteCollectionRowsBatch`, add a block mirroring the other tables (place it next to the `facetCounts` block). It returns `false` (more work) if it deleted any:

```ts
  const facetPostings = await ctx.db
    .query("facetPostings")
    .withIndex("by_collection_field_value", (q) => q.eq("collection", name))
    .take(batchSize);
  if (facetPostings.length > 0) {
    for (const r of facetPostings) await ctx.db.delete(r._id);
    return false;
  }
```

- [ ] **Step 3: Extend the existing deleteCollection test**

In `src/component/collections.test.ts`, the test "deleteCollection removes the collection, its documents, posting chunks, terms, and trigrams" upserts a doc and asserts leftover tables are empty. Add facetPostings to that collection's config and assertion. In that test, change `createCollection` to include facets and re-upsert with a facet value, then add to the `leftover` object:

```ts
      facetPostings: await ctx.db
        .query("facetPostings")
        .withIndex("by_collection_field_value", (q) => q.eq("collection", "products"))
        .collect(),
```

and assert `expect(leftover.facetPostings).toEqual([]);`. To make the doc create a facetPostings row, change that test's `createCollection` call to add `facetFields: ["name"]` and `filterFields: [{ field: "name", type: "string" as const }]` (name is already stored), and the upserted doc already has `name`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --typecheck src/component/collections.test.ts`
Expected: pass, 0 type errors.

Run: `npm test`
Expected: ≥ 218 passing, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/component/collections.ts src/component/collections.test.ts
git commit -m "feat: tear down and health-check facetPostings with the collection"
```

---

### Task 6: Filtered-facet read path via intersection

**Files:**
- Modify: `src/component/search.ts` (the `filter + facet` tally + the byId load decision)
- Test: `src/component/facet-search.test.ts`

**Interfaces:**
- Consumes: `filterDocKeys: Set<number>`, `filterComplete: boolean` (Task 2); `readFacetPostingDocKeys` (Task 3); `facetValuesForField` via the existing `facetCounts` `by_field` enumeration.
- Produces: filtered facet counts computed by intersection; full-matched-set `loadDocs` no longer required solely for facet tallying.

- [ ] **Step 1: Add a facet-values enumerator**

In `src/component/facetCounts.ts`, add (it already has `readFacetCounts` reading the `by_field` index):

```ts
// Distinct values of a facet field (bounded by FACET_VALUE_READ_BUDGET), for
// driving the filtered-facet intersection.
export async function facetValuesForField(
  ctx: QueryCtx,
  collection: string,
  field: string,
): Promise<string[]> {
  const rows = await ctx.db
    .query("facetCounts")
    .withIndex("by_field", (q) => q.eq("collection", collection).eq("field", field))
    .take(FACET_VALUE_READ_BUDGET);
  return rows.map((r) => r.value);
}
```

- [ ] **Step 2: Use intersection in the filtered-facet tally**

In `src/component/search.ts`, the facet tally block (the `if (hasFacets) { ... }` section) currently, for the non-global case, iterates `facetIds` and reads `storedOf(id)[field]`. Add an intersection path that runs when we have a complete filter docKey set. Import at top:

```ts
import { readFacetCounts, facetValuesForField } from "./facetCounts";
import { readFacetPostingDocKeys } from "./facetPostings";
```

In the per-field loop, before the in-memory `tally`, add: when `filterDocKeys && filterComplete` (the filtered path with a usable index), compute counts by intersection and continue:

```ts
        if (filterDocKeys && filterComplete) {
          const values = await facetValuesForField(ctx, args.collection, field);
          const counts: { value: string; count: number }[] = [];
          for (const value of values) {
            const post = await readFacetPostingDocKeys(ctx, args.collection, field, value);
            const [small, big] = post.size <= filterDocKeys.size ? [post, filterDocKeys] : [filterDocKeys, post];
            let n = 0;
            for (const k of small) if (big.has(k)) n++;
            if (n > 0) counts.push({ value, count: n });
          }
          counts.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
          facet_counts.push({ field_name: field, counts: counts.slice(0, maxValues) });
          continue;
        }
```

This sits inside the `for (const field of args.facetBy as string[])` loop, after the `globalFacets` branch and before the existing in-memory `tally` (which remains the fallback for the incomplete-index case and the non-filter case).

- [ ] **Step 3: Don't load the whole matched set just for facets**

In the `filterIds` branch of the working-set build (around lines 205-213), the `else` arm loads ALL matched docs when `hasFacets || hasCustomOrder`. Now that complete-index facets need no docs, only load the full set when `hasCustomOrder` OR the facet path can't use the index. Replace that branch:

```ts
    } else if (filterIds) {
      matchedIds = [...filterIds];
      // Facets via the inverted index need no docs; only custom ordering (or a
      // facet request that can't use the index) needs the full matched set.
      const facetsNeedDocs = hasFacets && !(filterDocKeys && filterComplete);
      if (!facetsNeedDocs && !hasCustomOrder) {
        const pageStart = (page - 1) * perPage;
        byId = await loadDocs(ctx, args.collection, matchedIds.slice(pageStart, pageStart + perPage));
      } else {
        byId = await loadDocs(ctx, args.collection, matchedIds);
      }
    } else if (hasRank) {
```

- [ ] **Step 4: Test filtered facets are exact and bounded**

Append to `src/component/facet-search.test.ts`:

```ts
  it("filtered facet counts come from the inverted index and match a brute tally", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "fs",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [
        { field: "inStock", type: "string" as const },
        { field: "category", type: "string" as const },
      ],
      facetFields: ["category"],
    });
    // 6 docs: 4 in stock (2 Eng, 2 Sales), 2 out (1 Eng, 1 Sales).
    const docs = [
      { id: "1", doc: { name: "a", inStock: "true", category: "Eng" } },
      { id: "2", doc: { name: "b", inStock: "true", category: "Eng" } },
      { id: "3", doc: { name: "c", inStock: "true", category: "Sales" } },
      { id: "4", doc: { name: "d", inStock: "true", category: "Sales" } },
      { id: "5", doc: { name: "e", inStock: "false", category: "Eng" } },
      { id: "6", doc: { name: "f", inStock: "false", category: "Sales" } },
    ];
    await t.mutation(api.write.upsertMany, { collection: "fs", docs });
    const r = await t.query(api.search.search, {
      collection: "fs", q: "", filterBy: "inStock:true", facetBy: ["category"],
    });
    const counts = Object.fromEntries(
      (r.facet_counts.find((f: any) => f.field_name === "category")?.counts ?? []).map((c: any) => [c.value, c.count]),
    );
    // Among inStock=true only: Eng 2, Sales 2 (the out-of-stock docs excluded).
    expect(counts).toEqual({ Eng: 2, Sales: 2 });
    expect(r.found).toBe(4);
  });
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run --typecheck src/component/facet-search.test.ts src/component/search.test.ts src/component/filter.test.ts`
Expected: pass, 0 type errors.

Run: `npm test`
Expected: ≥ 219 passing, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/component/search.ts src/component/facetCounts.ts src/component/facet-search.test.ts
git commit -m "feat: filtered facet counts via inverted-index intersection"
```

---

### Task 7: Backfill for existing collections

**Files:**
- Modify: `src/component/write.ts` (a backfill mutation) OR a new `src/component/backfill.ts`
- Modify: `src/component/collections.ts` if a pending flag is needed on the collection
- Test: `src/component/sync-reindex.test.ts`

**Interfaces:**
- Consumes: `addFacetPostings` (Task 3), the `documents` table (carries `docKey` + `stored`), `filters` rows lacking `docKey`.
- Produces: a replay path that, for each existing doc, (a) backfills `filters.docKey` and (b) populates `facetPostings`. The existing app-driven `reindex` (which replays docs through `upsert`) ALREADY rebuilds both via Tasks 1 & 4 — so the backfill is: **re-running the existing reindex replays the new structures.**

- [ ] **Step 1: Confirm reindex replays the new structures**

The example app's `reindex` ([example/convex/products.ts]) pages `productDocs` and calls `search.upsertMany`, which runs `upsertInternal` → now writes `filters.docKey` (Task 1) and `facetPostings` (Task 4). A replayed upsert first `clearDoc`s the doc (removing old filter/facet rows) then re-inserts with the new fields. So **reindex is the backfill** — no new component code is required for the happy path.

Add a test proving a pre-existing doc (written before the new fields existed) gets corrected by a reindex-style replay. Append to `src/component/sync-reindex.test.ts`:

```ts
  it("replaying a doc populates filters.docKey and facetPostings", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "bf",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }],
      facetFields: ["brand"],
    });
    await t.mutation(api.write.upsert, { collection: "bf", id: "a", doc: { name: "x", brand: "Acme" } });
    // Simulate a pre-migration filters row: strip its docKey.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("filters").withIndex("by_doc", (q) => q.eq("collection", "bf").eq("docId", "a")).unique();
      if (row) await ctx.db.patch(row._id, { docKey: undefined });
    });
    // Replay (what reindex does): upsert the same doc again.
    await t.mutation(api.write.upsert, { collection: "bf", id: "a", doc: { name: "x", brand: "Acme" } });
    const { hasDocKey, postings } = await t.run(async (ctx) => {
      const row = await ctx.db.query("filters").withIndex("by_doc", (q) => q.eq("collection", "bf").eq("docId", "a")).unique();
      const post = await ctx.db.query("facetPostings").withIndex("by_collection_field_value", (q) => q.eq("collection", "bf").eq("field", "brand").eq("value", "Acme")).collect();
      return { hasDocKey: typeof row?.docKey === "number", postings: post.flatMap((r) => r.docKeys).length };
    });
    expect(hasDocKey).toBe(true);
    expect(postings).toBe(1);
  });
```

- [ ] **Step 2: Run it (must pass — replay already does the work)**

Run: `npx vitest run --typecheck src/component/sync-reindex.test.ts`
Expected: PASS (the replay path from Tasks 1 & 4 already corrects both structures).

If it FAILS, the write path isn't fully rebuilding on replay — fix `upsertInternal`/`clearDoc` so a replay corrects `filters.docKey` and `facetPostings`, then re-run.

- [ ] **Step 3: Document the backfill contract**

Add a comment block at the top of `src/component/facetPostings.ts` stating: existing collections are migrated by replaying their docs through `upsert` (the app's `reindex`); until a collection is fully replayed, its filter resolves may report `complete: false` (rows missing `docKey`), and the read path falls back to load-and-tally (Task 6 Step 2 guard `filterComplete`). This makes the "no wrong counts while incomplete" guarantee explicit in code.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: ≥ 220 passing, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/component/facetPostings.ts src/component/sync-reindex.test.ts
git commit -m "feat: document and test reindex-as-backfill for the facet index"
```

---

### Task 8: Whole-project typecheck + cloud benchmark + merge

**Files:** none (verification + git)

- [ ] **Step 1: Whole-project typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: ≥ 220 passing, 0 type errors.

- [ ] **Step 3: Deploy to cloud dev and reindex the existing 5k**

The 5k data predates this index, so its `filters` rows lack `docKey` and it has no `facetPostings`. Deploy and replay:

```bash
npx convex dev --once
npx convex run products:startSeed '{"reset": false}' --deployment dev
```
(`startSeed` with existing data triggers `recomputeAffinities`, which replays every doc through `upsert` — backfilling both structures. If a dedicated reindex is exposed, prefer `npx convex run products:reindex '{}' --deployment dev`.)

Wait for replay to finish, then confirm health:

Run: `npx convex run products:indexStats '{}' --deployment dev`
Expected: `out_of: 5000`.

- [ ] **Step 4: Benchmark — boolean+facet must not throw**

Run: `npx convex run products:benchmark '{}' --deployment dev` (twice; use the warm second run).
Expected: `boolean+facet` returns WITHOUT a "Too many reads" error, `found: 4000`, and low ms (no 4000-doc load). Record the boolean+facet ms before/after. If it still throws, the read path is still loading the full set — investigate Task 6 Step 3.

- [ ] **Step 5: Merge**

```bash
git checkout main
git merge --ff-only feat/inverted-facet-index
git branch -d feat/inverted-facet-index
git log --oneline -8
```

- [ ] **Step 6: Re-deploy main to cloud dev**

Run: `npx convex dev --once`
Expected: cloud dev runs merged main.

---

## Notes for the implementer

- `npm test` = `vitest run --typecheck` (tests + typecheck of test files). `npm run typecheck` is the separate whole-project pass; run it in Task 8.
- Convex-test does NOT enforce the 4096-read limit, so unit tests prove correctness; the read reduction is proven by the Task 8 cloud benchmark (boolean+facet no longer throwing).
- The `complete: false` fallback (Task 2 + Task 6 guard) is the safety net: a mid-backfill collection returns correct (load-and-tally) counts, never under-counts from a partial index.
- Do not push to origin; the user merges/pushes. Cloud deploys are `--deployment dev` only.
