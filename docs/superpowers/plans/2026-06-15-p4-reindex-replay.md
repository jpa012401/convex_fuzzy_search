# P4: App-Driven Reindex Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `sync` marks a collection's fields "pending" (a structural field added to an index-only component that lacks the snapshot to self-backfill), provide an app-driven reindex: the app pages its own table and re-upserts each doc; once complete, the pending flag clears.

**Architecture:** The reindex *replays app data through the existing `upsert` path* (which rebuilds filters/facets/sort from the doc). The app owns the page source (its own table). A component mutation `clearPendingFields(collection)` marks the collection fully reindexed. The client exposes `pendingFields(ctx, collection)` to read what's pending and `clearPending(ctx, collection)` to finish. Paging/scheduling is app code (matching the existing `seedChain`/`backfill*` self-chaining pattern).

**Tech Stack:** Convex component, TypeScript, vitest + convex-test. Depends on P3 (`pendingFields`).

---

## File Structure

- Modify: `src/component/configSync.ts` — add `clearPendingFields` mutation.
- Modify: `src/client/index.ts` — `pendingFields(ctx, name)` query + `clearPending(ctx, name)` mutation wrappers.
- Modify: `example/convex/products.ts` — a `reindex` self-chaining mutation that replays `productDocs` through `upsert`, then clears pending.
- Test: `src/component/configSync.test.ts` (extend), `src/client/sync.test.ts` (extend).

## Background facts (verified against current code)

- `upsert` (`write.ts:136`) already rebuilds ALL index rows for a doc (postings/filters/facets/sort) from the passed doc — so replaying a doc through `upsert` is a complete reindex of that doc under the *current* config (including any newly-added field).
- `pendingFields` added to the `collections` row in P3 Task 2.
- The example's app-owned serving table `productDocs` is added in P1 Task 4 — it is the replay source.

---

### Task 1: `clearPendingFields` component mutation

**Files:**
- Modify: `src/component/configSync.ts`
- Test: `src/component/configSync.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/component/configSync.test.ts`:

```ts
it("clearPendingFields empties the pending list", async () => {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.configSync.applyCollectionConfig, {
    config: { name: "p", searchFields: ["name"], storedFields: "derived" },
  });
  await t.mutation(api.configSync.applyCollectionConfig, {
    config: { name: "p", searchFields: ["name"], storedFields: "derived", filterFields: [{ field: "brand", type: "string" }] },
  });
  await t.mutation(api.configSync.clearPendingFields, { collection: "p" });
  const c = await t.query(api.collections.getCollection, { name: "p" });
  expect(c?.pendingFields ?? []).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/component/configSync.test.ts -t "clearPendingFields"`
Expected: FAIL — mutation does not exist.

- [ ] **Step 3: Implement the mutation**

Add to `src/component/configSync.ts`:

```ts
import { requireCollection } from "./collections";

// Mark a collection fully reindexed. The app calls this after replaying all of
// its documents through upsert (which rebuilt the newly-added field's index rows).
export const clearPendingFields = mutation({
  args: { collection: v.string() },
  handler: async (ctx, { collection }) => {
    const c = await requireCollection(ctx, collection);
    await ctx.db.patch(c._id, { pendingFields: [] });
  },
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/component/configSync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/component/configSync.ts src/component/configSync.test.ts
git commit -m "feat(component): clearPendingFields mutation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Client wrappers `pendingFields` + `clearPending`

**Files:**
- Modify: `src/client/index.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/client/sync.test.ts`:

```ts
it("pendingFields reads what sync flagged; clearPending empties it", async () => {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  const search = new FuzzySearch(api as any, {
    collections: { p: { searchFields: ["name"], filterFields: [{ field: "brand", type: "string" }] } },
  });
  // create without the filter, then add it, to force pending:
  await t.mutation(api.configSync.applyCollectionConfig, {
    config: { name: "p", searchFields: ["name"], storedFields: "derived" },
  });
  await t.run(async (ctx) => { await search.sync(ctx as any); });
  const pending = await t.run(async (ctx) => search.pendingFields(ctx as any, "p"));
  expect(pending).toContain("brand");
  await t.run(async (ctx) => { await search.clearPending(ctx as any, "p"); });
  const after = await t.run(async (ctx) => search.pendingFields(ctx as any, "p"));
  expect(after).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/client/sync.test.ts -t "pendingFields"`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Add the wrappers**

In `src/client/index.ts` `FuzzySearch`:

```ts
  async pendingFields(ctx: QueryCtx, collection: string): Promise<string[]> {
    const c = await ctx.runQuery(this.component.collections.getCollection, { name: collection });
    return (c?.pendingFields as string[] | undefined) ?? [];
  }

  async clearPending(ctx: MutationCtx, collection: string): Promise<void> {
    await ctx.runMutation(this.component.configSync.clearPendingFields, { collection });
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/client/sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc -p tsconfig.build.json --noEmit
git add src/client/index.ts src/client/sync.test.ts
git commit -m "feat(client): pendingFields + clearPending wrappers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Example `reindex` self-chaining replay

**Files:**
- Modify: `example/convex/products.ts`

- [ ] **Step 1: Add a self-chaining reindex mutation**

Add to `example/convex/products.ts` (mirrors the existing `seedChain` pattern):

```ts
// Replays the app-owned productDocs through the component's upsert, rebuilding
// index rows for any newly-added structural field. Self-chains in the
// background, then clears the collection's pending flag. Page source is the
// APP's table (the component no longer holds the full serving doc).
export const reindex = mutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), batch: v.optional(v.number()) },
  handler: async (ctx, { cursor, batch }) => {
    const size = batch ?? 100;
    const page = await ctx.db
      .query("productDocs")
      .withIndex("by_docId", (q) => (cursor == null ? q : q.gt("docId", cursor)))
      .take(size + 1);
    const rows = page.slice(0, size);
    await search.upsertMany(ctx, {
      collection: COLLECTION,
      docs: rows.map((r) => ({ id: r.docId, doc: r.doc })),
    });
    const done = page.length <= size;
    if (!done) {
      await ctx.scheduler.runAfter(0, api.products.reindex, { cursor: rows[rows.length - 1].docId, batch });
    } else {
      await search.clearPending(ctx, COLLECTION);
    }
    return { indexed: rows.length, done };
  },
});
```

- [ ] **Step 2: Typecheck the example**

Run: `cd example && npx tsc -p convex/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add example/convex/products.ts
git commit -m "example: app-driven reindex replays productDocs, clears pending

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Document the operational contract

**Files:**
- Modify: `docs/usage.md`

- [ ] **Step 1: Add a "Changing a collection's fields (reindex)" section**

Append to `docs/usage.md`:

```markdown
## Changing a collection's fields (reindex)

Edit your `collections` config object and run `search.sync(ctx)` (e.g. a
`sync` mutation invoked post-deploy). Two cases:

- **Metadata change** (rankProfiles, weights, searchFields): applies instantly,
  O(1). Nothing else to do.
- **Structural addition** (new filterField / facetField / sortSpec): `sync`
  marks the field *pending* — existing documents have no index rows for it yet.
  Run your app-driven **reindex** (page your own table, re-`upsert` each doc),
  then `search.clearPending(ctx, collection)`. Until reindex completes, queries
  on the new field return *incomplete* (not erroneous) results.

Because writes are explicit (like the aggregate component), bulk imports or
dashboard edits to your app tables do **not** reach the component — replay the
affected docs through `upsert` to resync.
```

- [ ] **Step 2: Commit**

```bash
git add docs/usage.md
git commit -m "docs: reindex + drift operational contract

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review notes

- Spec coverage: app-driven reindex via replay (Task 3), pending read/clear (Task 1-2), partial-results window documented (Task 4), drift/bulk-load contract (Task 4). ✓
- Reindex correctness: replaying through `upsert` rebuilds the doc's full index under current config, so a newly-added field is indexed — no separate per-field backfill needed. ✓
- Type consistency: `clearPendingFields` (component) ↔ `clearPending` (client) ↔ `pendingFields` (client read). Page source is `productDocs.by_docId` (defined in P1 Task 4).
- Dependency: requires P3 (`pendingFields` column + `applyCollectionConfig`) and P1 (`productDocs` table). Note at top.
