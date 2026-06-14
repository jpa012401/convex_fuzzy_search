# Phase 4 · S1 — Aggregate Backbone + Lean Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop loading the whole collection per query — `out_of` from an aggregate counter, text queries load only matched docs, simple browse paginates off the aggregate.

**Architecture:** `@convex-dev/aggregate` is installed inside the component (already done + spike-verified) as instance `docCount`. A `DirectAggregate` namespaced by collection, keyed by `docId`, is maintained in the synchronous write path. `search` reads `out_of` via `count`, loads only the docs a given query needs, and pages browse via `at`.

**Tech Stack:** Convex component, `@convex-dev/aggregate` (`DirectAggregate`), TypeScript (`verbatimModuleSyntax` ON), convex-test + Vitest.

**Spec:** `docs/superpowers/specs/2026-06-14-phase4-s1-aggregate-lean-reads-design.md`

**Already done (committed, spike-verified):** `src/component/convex.config.ts` has `component.use(aggregate, { name: "docCount" })`; `@convex-dev/aggregate` installed; `components.docCount` generated; `DirectAggregate` supports `{ Namespace; Key; Id }` with `insert/insertIfDoesNotExist/delete/deleteIfExists/count/at/clear`; tests register the nested component via `import { register } from "@convex-dev/aggregate/test"; register(t, "docCount")`.

**Repo conventions:** colocated tests; after schema/function changes run `npm run build:codegen`. `verbatimModuleSyntax` → `import type` for types. **Every component test that touches counters must call `register(t, "docCount")` after `convexTest(...)`.**

---

## Task 1: `counters.ts` — aggregate wrapper

**Files:** Create `src/component/counters.ts`; Test `src/component/counters.test.ts`.

- [ ] **Step 1: Write failing test `src/component/counters.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { collectionCount, pageDocIds, addDoc, removeDoc } from "./counters";

const modules = import.meta.glob("./**/*.ts");

describe("counters", () => {
  it("counts, pages, and decrements per collection namespace", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.run(async (ctx) => {
      await addDoc(ctx, "c1", "a");
      await addDoc(ctx, "c1", "b");
      await addDoc(ctx, "c1", "a"); // idempotent
      await addDoc(ctx, "c2", "z");
    });
    expect(await t.run((ctx) => collectionCount(ctx, "c1"))).toBe(2);
    expect(await t.run((ctx) => collectionCount(ctx, "c2"))).toBe(1);
    // page off the aggregate, ordered by key (docId)
    expect(await t.run((ctx) => pageDocIds(ctx, "c1", 0, 1))).toEqual(["a"]);
    expect(await t.run((ctx) => pageDocIds(ctx, "c1", 1, 5))).toEqual(["b"]);
    await t.run((ctx) => removeDoc(ctx, "c1", "a"));
    expect(await t.run((ctx) => collectionCount(ctx, "c1"))).toBe(1);
    expect(await t.run((ctx) => removeDoc(ctx, "c1", "missing"))); // idempotent, no throw
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/counters.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/component/counters.ts`**

```ts
import { DirectAggregate } from "@convex-dev/aggregate";
import { components } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";

// One balanced-tree aggregate, namespaced by collection, keyed by docId.
// Gives O(log n) count and at(offset) — so out_of and browse pagination don't
// scan the documents table.
const docAgg = new DirectAggregate<{
  Namespace: string;
  Key: string;
  Id: string;
}>(components.docCount);

export async function addDoc(ctx: MutationCtx, collection: string, docId: string) {
  await docAgg.insertIfDoesNotExist(ctx, { namespace: collection, key: docId, id: docId });
}

export async function removeDoc(ctx: MutationCtx, collection: string, docId: string) {
  await docAgg.deleteIfExists(ctx, { namespace: collection, key: docId, id: docId });
}

export async function collectionCount(ctx: QueryCtx, collection: string): Promise<number> {
  return await docAgg.count(ctx, { namespace: collection });
}

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

// Empty a collection's namespace (used by deleteCollection — scalable clear).
export async function clearCollectionCount(ctx: MutationCtx, collection: string) {
  await docAgg.clear(ctx, { namespace: collection });
}
```

- [ ] **Step 4: Regenerate + run, verify PASS**

Run: `npm run build:codegen && npx vitest run src/component/counters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/component/counters.ts src/component/counters.test.ts src/component/_generated
git commit -m "feat: aggregate-backed per-collection doc counters"
```

---

## Task 2: Maintain the counter in the write path

**Files:** Modify `src/component/write.ts`, `src/component/collections.ts`; Test `src/component/counters-write.test.ts`.

- [ ] **Step 1: Write failing test `src/component/counters-write.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { collectionCount } from "./counters";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, { name: "products", searchFields: ["name"] });
  return t;
}

describe("write path maintains the counter", () => {
  it("increments on new, is stable on re-upsert, decrements on delete", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "red shoe" } });
    await t.mutation(api.write.upsert, { collection: "products", id: "p2", doc: { name: "blue hat" } });
    expect(await t.run((ctx) => collectionCount(ctx, "products"))).toBe(2);
    // re-upsert same id: count unchanged
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "green shoe" } });
    expect(await t.run((ctx) => collectionCount(ctx, "products"))).toBe(2);
    await t.mutation(api.write.delete, { collection: "products", id: "p1" });
    expect(await t.run((ctx) => collectionCount(ctx, "products"))).toBe(1);
  });

  it("deleteCollection clears the namespace count", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "x" } });
    await t.mutation(api.collections.deleteCollection, { name: "products" });
    expect(await t.run((ctx) => collectionCount(ctx, "products"))).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/counters-write.test.ts`
Expected: FAIL — counts are 0 (not maintained yet).

- [ ] **Step 3: Maintain the counter in `src/component/write.ts`**

Add import:
```ts
import { addDoc, removeDoc } from "./counters";
```

Change `clearDoc` to report whether the document existed (so upsert can tell new from replace), and remove it from the counter when it did:
```ts
async function clearDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
): Promise<{ oldTerms: Set<string>; existed: boolean }> {
  const postings = await ctx.db
    .query("postings")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .collect();
  const oldTerms = new Set<string>(postings.map((p) => p.term));
  for (const p of postings) await ctx.db.delete(p._id);

  const existing = await ctx.db
    .query("documents")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .unique();
  if (existing) await ctx.db.delete(existing._id);

  return { oldTerms, existed: existing !== null };
}
```

Update `upsertInternal` to use the new return and add to the counter only for new docs:
```ts
async function upsertInternal(
  ctx: MutationCtx,
  collection: string,
  id: string,
  doc: Doc,
) {
  const col = await requireCollection(ctx, collection);
  const { oldTerms, existed } = await clearDoc(ctx, collection, id);

  const newTerms = new Set<string>();
  for (const field of col.searchFields) {
    const value = doc[field];
    if (typeof value !== "string") continue;
    const counts = new Map<string, number>();
    for (const term of tokenize(value)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
      newTerms.add(term);
    }
    for (const [term, tf] of counts) {
      await ctx.db.insert("postings", { collection, term, docId: id, field, tf });
    }
  }

  await ctx.db.insert("documents", {
    collection,
    docId: id,
    stored: project(doc, col.storedFields),
  });

  await applyTermDiff(ctx, collection, oldTerms, newTerms);
  if (!existed) await addDoc(ctx, collection, id); // key unchanged on replace
}
```

Update `deleteDoc`'s handler to use the new return and decrement:
```ts
export const deleteDoc = mutation({
  args: { collection: v.string(), id: v.string() },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collection);
    const { oldTerms, existed } = await clearDoc(ctx, args.collection, args.id);
    await applyTermDiff(ctx, args.collection, oldTerms, new Set());
    if (existed) await removeDoc(ctx, args.collection, args.id);
  },
});
```

- [ ] **Step 4: Clear the namespace in `deleteCollection` (`src/component/collections.ts`)**

Add import `import { clearCollectionCount } from "./counters";` and, in the `deleteCollection` handler, after deleting the rows and before `await ctx.db.delete(c._id);`, add:
```ts
    await clearCollectionCount(ctx, args.name);
```

- [ ] **Step 5: Regenerate + run (new test + existing write tests)**

Run: `npm run build:codegen && npx vitest run src/component/counters-write.test.ts src/component/write.test.ts src/component/collections.test.ts`
Expected: PASS — new counter-maintenance tests + all existing write/collection tests still green.

Note: existing `write.test.ts`/`collections.test.ts` do NOT call `registerAggregate`. Because the write path now calls the aggregate, those tests must register it too. Update each affected test file's setup to add `registerAggregate(t, "docCount")` right after `convexTest(...)` (import `register as registerAggregate` from `@convex-dev/aggregate/test`). Apply the same to ANY existing test whose mutations call `upsert`/`delete`/`deleteCollection`.

- [ ] **Step 6: Commit**

```bash
git add src/component/write.ts src/component/collections.ts src/component/*.test.ts src/component/_generated
git commit -m "feat: maintain aggregate doc counter in the write path"
```

---

## Task 3: Lean reads in `search.ts`

**Files:** Modify `src/component/search.ts`; Test `src/component/search.test.ts` (append + register aggregate).

- [ ] **Step 1: Add registration to the existing search tests**

In `src/component/search.test.ts`, import `register as registerAggregate from "@convex-dev/aggregate/test"` and call `registerAggregate(t, "docCount")` immediately after every `convexTest(schema, modules)` (in `setup`, `setupFacets`, `setupShop`, and any inline `convexTest`). This is required now that search reads the counter and the write path maintains it.

- [ ] **Step 2: Append failing tests to `src/component/search.test.ts`**

```ts
describe("S1 lean reads", () => {
  it("out_of comes from the counter and matches the collection size", async () => {
    const t = await setup(); // 3 docs
    const r = await t.query(api.search.search, { collection: "products", q: "" });
    expect(r.out_of).toBe(3);
  });

  it("text search returns the same results as before (lean path)", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, { collection: "products", q: "red" });
    expect(r.found).toBe(2);
    expect(r.out_of).toBe(3);
    expect(r.hits.map((h: any) => h.document.name).sort()).toEqual(["Red Hat", "Red Running Shoe"]);
  });

  it("simple browse pages off the aggregate", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, { collection: "products", q: "", page: 1, perPage: 2 });
    expect(r.found).toBe(3);
    expect(r.hits.length).toBe(2);
    // docId-ordered (p1,p2,p3): page 1 = p1,p2
    expect(r.hits.map((h: any) => h.document.name)).toEqual(["Red Running Shoe", "Blue Running Jacket"]);
  });

  it("browse + filter still works (fallback path)", async () => {
    const t = await setupFacets(); // shop collection w/ brand filter
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "brand:Aurora" });
    expect(r.found).toBe(2);
  });
});
```

- [ ] **Step 3: Run, verify the new tests' expectations drive change**

Run: `npx vitest run src/component/search.test.ts`
Expected: the browse-order test and/or out_of test FAIL against the current full-load implementation (current browse orders by docId via sort of all docs; out_of currently from allDocs.length). Confirm at least one new assertion fails before implementing.

- [ ] **Step 4: Replace `src/component/search.ts`**

```ts
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import { candidateTermsForToken } from "./matching";
import { parseFilter } from "./filter";
import { highlightField } from "./highlight";
import { orderingScore, compareMatches } from "./ranking";
import { collectionCount, pageDocIds } from "./counters";
import type { SearchResult, Hit, FacetCount } from "./types";

const MAX_PER_PAGE = 250;

async function docScoresForToken(
  ctx: QueryCtx,
  collection: string,
  candidates: Map<string, number>,
  queryBy: string[] | undefined,
): Promise<Map<string, number>> {
  const docScore = new Map<string, number>();
  for (const [term, score] of candidates) {
    const rows = await ctx.db
      .query("postings")
      .withIndex("by_collection_term", (q) =>
        q.eq("collection", collection).eq("term", term),
      )
      .collect();
    for (const r of rows) {
      if (queryBy && !queryBy.includes(r.field)) continue;
      const cur = docScore.get(r.docId);
      if (cur === undefined || score > cur) docScore.set(r.docId, score);
    }
  }
  return docScore;
}

// Load only the named docs (bounded by ids.length, not the collection).
async function loadDocs(
  ctx: QueryCtx,
  collection: string,
  ids: string[],
): Promise<Map<string, unknown>> {
  const byId = new Map<string, unknown>();
  for (const id of ids) {
    const row = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) =>
        q.eq("collection", collection).eq("docId", id),
      )
      .unique();
    if (row) byId.set(id, row.stored);
  }
  return byId;
}

export const search = query({
  args: {
    collection: v.string(),
    q: v.string(),
    page: v.optional(v.number()),
    perPage: v.optional(v.number()),
    queryBy: v.optional(v.array(v.string())),
    filterBy: v.optional(v.string()),
    facetBy: v.optional(v.array(v.string())),
    maxFacetValues: v.optional(v.number()),
    rankBy: v.optional(
      v.object({
        text: v.optional(v.number()),
        fields: v.optional(v.array(v.object({ field: v.string(), weight: v.number() }))),
      }),
    ),
    sortBy: v.optional(
      v.array(v.object({ field: v.string(), order: v.union(v.literal("asc"), v.literal("desc")) })),
    ),
  },
  handler: async (ctx, args): Promise<SearchResult> => {
    const start = Date.now();
    const collection = await requireCollection(ctx, args.collection);
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(args.perPage ?? 10)));
    const out_of = await collectionCount(ctx, args.collection);

    const tokens = tokenize(args.q);
    const hasFilter = !!(args.filterBy && args.filterBy.trim() !== "");
    const hasFacets = !!(args.facetBy && args.facetBy.length > 0);
    const hasCustomOrder =
      (!!args.sortBy && args.sortBy.length > 0) ||
      (!!args.rankBy && ((args.rankBy.fields?.length ?? 0) > 0 || args.rankBy.text !== undefined));

    // ---- LEAN BROWSE: empty q, no filter/facets/custom order -> page off the aggregate.
    if (tokens.length === 0 && !hasFilter && !hasFacets && !hasCustomOrder) {
      const ids = await pageDocIds(ctx, args.collection, (page - 1) * perPage, perPage);
      const byId = await loadDocs(ctx, args.collection, ids);
      const hits: Hit[] = ids.map((id) => ({
        document: (byId.get(id) ?? {}) as Record<string, unknown>,
        highlight: {},
        text_match: 0,
      }));
      return { found: out_of, page, out_of, search_time_ms: Date.now() - start, hits, facet_counts: [] };
    }

    // ---- Build the working set (byId) + match ids + scores.
    let matchedIds: string[];
    let scoreById: Map<string, number> | null = null;
    const matchedTerms = new Set<string>();
    let byId: Map<string, unknown>;

    if (tokens.length > 0) {
      // TEXT PATH: candidate set from postings; load ONLY those docs.
      const perToken: Map<string, number>[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const candidates = await candidateTermsForToken(ctx, args.collection, tokens[i], i === tokens.length - 1);
        for (const term of candidates.keys()) matchedTerms.add(term);
        perToken.push(await docScoresForToken(ctx, args.collection, candidates, args.queryBy));
      }
      perToken.sort((a, b) => a.size - b.size);
      const [first, ...rest] = perToken;
      scoreById = new Map();
      if (first) {
        for (const [docId, s0] of first) {
          if (rest.every((m) => m.has(docId))) {
            let total = s0;
            for (const m of rest) total += m.get(docId)!;
            scoreById.set(docId, total);
          }
        }
      }
      matchedIds = [...scoreById.keys()];
      byId = await loadDocs(ctx, args.collection, matchedIds);
    } else {
      // FALLBACK (browse + filter/facets/custom order): load the whole collection.
      const allDocs = await ctx.db
        .query("documents")
        .withIndex("by_collection_doc", (q) => q.eq("collection", args.collection))
        .collect();
      byId = new Map(allDocs.map((d) => [d.docId, d.stored]));
      matchedIds = allDocs.map((d) => d.docId);
    }

    const storedOf = (id: string) => (byId.get(id) ?? {}) as Record<string, unknown>;

    if (hasFilter) {
      const fieldTypes: Record<string, "string" | "number"> = {};
      for (const f of collection.filterFields ?? []) fieldTypes[f.field] = f.type;
      const predicate = parseFilter(args.filterBy as string, fieldTypes);
      matchedIds = matchedIds.filter((id) => predicate(storedOf(id)));
    }

    const found = matchedIds.length;

    const rawScore = (id: string) => (scoreById ? (scoreById.get(id) ?? 0) : 0);
    const orderScore = (id: string) => orderingScore(rawScore(id), storedOf(id), args.rankBy);
    matchedIds.sort((a, b) =>
      compareMatches(a, b, { score: orderScore, stored: storedOf, sortBy: args.sortBy }),
    );

    const facet_counts: FacetCount[] = [];
    if (hasFacets) {
      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
      for (const field of args.facetBy as string[]) {
        if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
        const tally = new Map<string, number>();
        for (const id of matchedIds) {
          const raw = storedOf(id)[field];
          if (raw === undefined || raw === null) continue;
          const value = String(raw);
          tally.set(value, (tally.get(value) ?? 0) + 1);
        }
        const counts = [...tally.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .slice(0, maxValues)
          .map(([value, count]) => ({ value, count }));
        facet_counts.push({ field_name: field, counts });
      }
    }

    const pageIds = matchedIds.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
    const fields = args.queryBy ?? collection.searchFields;
    const hits: Hit[] = pageIds.map((id) => {
      const stored = storedOf(id);
      const highlight: Record<string, { snippet: string; matched_tokens: string[] }> = {};
      if (matchedTerms.size > 0) {
        for (const field of fields) {
          const value = stored[field];
          if (typeof value !== "string") continue;
          const h = highlightField(value, matchedTerms);
          if (h) highlight[field] = h;
        }
      }
      return { document: stored, highlight, text_match: rawScore(id) };
    });

    return { found, page, out_of, search_time_ms: Date.now() - start, hits, facet_counts };
  },
});
```

- [ ] **Step 5: Regenerate + run the WHOLE suite**

Run: `npm run build:codegen && npx vitest run`
Expected: ALL pass. The text/typo/prefix/filter/facet/sort tests are unchanged in behavior; new S1 tests pass. Note one intended behavior change: **simple browse is now docId-ordered via the aggregate** (it already was docId-ordered via `matchedIds.sort()` in the old code, so existing browse assertions remain valid). If any existing browse assertion depended on a non-docId order, reconcile it (it should not).

- [ ] **Step 6: Commit**

```bash
git add src/component/search.ts src/component/search.test.ts src/component/_generated
git commit -m "feat: lean reads in search (counter out_of, matched-only loads, aggregate browse)"
```

---

## Task 4: Backfill + example + verify at 5k + docs

**Files:** Create `src/component/backfill.ts`; Modify `README.md`; verify the example.

- [ ] **Step 1: Backfill function `src/component/backfill.ts`**

For deployments that indexed documents before S1, the counter is empty. Provide an idempotent paginated backfill (component-internal mutation) the consumer can run once.

```ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { addDoc } from "./counters";

// Backfill the doc counter for a collection, one bounded page at a time.
// Returns the next cursor (null when done). Idempotent.
export const backfillCounterPage = mutation({
  args: { collection: v.string(), cursor: v.optional(v.union(v.string(), v.null())), batch: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) => q.eq("collection", args.collection))
      .paginate({ cursor: args.cursor ?? null, numItems: args.batch ?? 200 });
    for (const d of result.page) await addDoc(ctx, args.collection, d.docId);
    return { cursor: result.isDone ? null : result.continueCursor, done: result.isDone };
  },
});
```

(Note: `addDoc` is idempotent via `insertIfDoesNotExist`, so re-running is safe.)

- [ ] **Step 2: Test the backfill** — append to `src/component/counters-write.test.ts`:

```ts
it("backfill rebuilds the counter for pre-existing docs", async () => {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, { name: "products", searchFields: ["name"] });
  // insert documents directly, bypassing the counter, to simulate pre-S1 data
  await t.run(async (ctx) => {
    await ctx.db.insert("documents", { collection: "products", docId: "x", stored: { name: "x" } });
    await ctx.db.insert("documents", { collection: "products", docId: "y", stored: { name: "y" } });
  });
  expect(await t.run((ctx) => collectionCount(ctx, "products"))).toBe(0);
  let cursor: string | null = null;
  do {
    const r: any = await t.mutation(api.backfill.backfillCounterPage, { collection: "products", cursor, batch: 1 });
    cursor = r.cursor;
  } while (cursor !== null);
  expect(await t.run((ctx) => collectionCount(ctx, "products"))).toBe(2);
});
```

Run: `npm run build:codegen && npx vitest run src/component/counters-write.test.ts` → PASS.

- [ ] **Step 3: Verify on the live 5k dataset**

The example write path now maintains the counter. Re-seed to populate it (the 5k load goes through `upsert`):
```bash
npx convex run products:startSeed '{"total":5000}'    # background; wait for out_of to reach 5000
# poll:
npx convex run products:searchProducts '{"q":""}'      # out_of should reach 5000
```
Then confirm lean reads work + measure: run the benchmark and compare `search_time_ms` / behavior to before:
```bash
npx convex run products:benchmark '{}'
```
Expected: same `found`/results as before; `out_of` correct; selective text queries no longer depend on collection size. Report the numbers.

- [ ] **Step 4: Update `README.md`**

In the pagination/limitations section, document the S1 change: `out_of` is an aggregate counter; text queries load only matched docs; simple browse pages off the aggregate; browse-with-filter/facets/custom-sort still loads the full set (S2–S4); and note the one-time `backfillCounterPage` for pre-existing data. Keep the honest remaining limits.

- [ ] **Step 5: Final verification + commit**

```bash
npx vitest run && npm run build && npm run typecheck
git add src/component/backfill.ts src/component/_generated README.md
git commit -m "feat: counter backfill + docs; verify lean reads at 5k"
```

---

## Self-Review notes (reconciled against the spec)

- **Spec coverage:** aggregate installed inside component ✔ (done, spike); DirectAggregate namespaced by collection keyed by docId ✔ (Task 1); maintained on write (insert new / delete / no-op replace) ✔ (Task 2); `out_of` from `count` ✔ (Task 3); text path loads matched-only ✔ (Task 3 `loadDocs`); simple browse pages off aggregate ✔ (Task 3 lean-browse branch); fallback for browse+filter/facets/custom-order ✔ (Task 3); deleteCollection clears namespace ✔ (Task 2 Step 4); backfill ✔ (Task 4); exactness preserved (text/filter/facet/sort identical) ✔.
- **Test registration:** every counter-touching test calls `registerAggregate(t, "docCount")` — Tasks 1, 2, 3 Step 1 explicitly add it to existing files.
- **Type/name consistency:** `addDoc/removeDoc/collectionCount/pageDocIds/clearCollectionCount` used identically across counters.ts, write.ts, collections.ts, search.ts, backfill.ts; `clearDoc` now returns `{ oldTerms, existed }` and both callers updated.
- **Known deferrals (documented):** browse+filter/facets/custom-sort full load (S2–S4); hot-term match-set size (S5); weighted rankBy stays candidate-based (fundamental).
- **Regression guard:** behavior of text/typo/prefix/filter/facet/sort/highlight unchanged — only read strategy changes; full suite must stay green.
