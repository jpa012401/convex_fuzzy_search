# P1: Search Returns IDs (drop `document`, keep `highlight`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `search.search` return `{ id, score, highlight }` per hit instead of the full document snapshot, so the app hydrates contents from its own tables.

**Architecture:** The component engine is unchanged (match → filter → facet → sort → re-rank); only the final hit-assembly and the `Hit`/`SearchResult` types change. `document` is removed from `Hit`; `id` and `score` are added; `highlight` is retained (the component still has the stored `searchField` text to compute snippets). The example app's `searchProducts`/`benchmark`/UI are updated to hydrate by id.

**Tech Stack:** Convex component, TypeScript, vitest + convex-test.

---

## File Structure

- Modify: `src/component/types.ts` — `Hit` type (drop `document`, add `id`/`score`).
- Modify: `src/component/search.ts` — all 5 hit-constructing return paths.
- Modify: `example/convex/products.ts` — `benchmark` reads `hit.id` not `hit.document.name`; add a hydrate helper.
- Test: `src/component/search.test.ts` (existing) — update assertions; add an id-shape test.

## Background facts (verified against current code)

- `Hit` today (`src/component/types.ts:1-5`): `{ document, highlight, text_match }`.
- `search.ts` constructs `Hit` in **5 places**: lines 108-112, 121-125, 153-157, 320-332 (text/rank path), and the browse-facet path. Each builds `{ document: stored, highlight, text_match: ... }`.
- `highlightField(value, matchedTerms)` (`src/component/highlight.ts`) builds snippets from a field's **string text**, which lives in the index-relevant stored fields — so highlight survives.
- Tests use: `convexTest(schema, modules)` + `registerAggregate(t, "docCount")` and `registerAggregate(t, "sortIndex")` where sort is exercised.

---

### Task 1: Change the `Hit` type to return id + score, keep highlight

**Files:**
- Modify: `src/component/types.ts:1-5`

- [ ] **Step 1: Write the failing test**

Add to `src/component/search.test.ts` (top-level, inside the existing describe or a new one):

```ts
it("returns id + score + highlight, not document", async () => {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "books",
    searchFields: ["title"],
  });
  await t.mutation(api.write.upsert, {
    collection: "books",
    id: "b1",
    doc: { title: "the great gatsby" },
  });
  const r = await t.query(api.search.search, { collection: "books", q: "gatsby" });
  expect(r.hits[0]).toMatchObject({ id: "b1" });
  expect(typeof r.hits[0].score).toBe("number");
  expect(r.hits[0].highlight).toBeDefined();
  expect((r.hits[0] as any).document).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/component/search.test.ts -t "returns id + score"`
Expected: FAIL — `hits[0].id` is undefined and `document` is still present.

- [ ] **Step 3: Edit the `Hit` type**

In `src/component/types.ts`, replace lines 1-5:

```ts
export type Hit = {
  id: string;
  score: number; // the doc's final ranked score (text_match in browse=0)
  highlight: Record<string, { snippet: string; matched_tokens: string[] }>;
};
```

- [ ] **Step 4: Do not run yet** — `search.ts` still references `.document`/`text_match`; compile will fail until Task 2. Proceed to Task 2.

---

### Task 2: Update all 5 hit-construction sites in search.ts

**Files:**
- Modify: `src/component/search.ts` (lines 108-112, 121-125, 153-157, the browse-facet path, and 320-332)

- [ ] **Step 1: Replace the three lean-browse hit builders**

Each of the three lean-browse paths currently builds:

```ts
const hits: Hit[] = ids.map((id) => ({
  document: (byId.get(id) ?? {}) as Record<string, unknown>,
  highlight: {},
  text_match: 0,
}));
```

Replace **each** occurrence (lines ~108-112, ~121-125, ~153-157) with:

```ts
const hits: Hit[] = ids.map((id) => ({ id, score: 0, highlight: {} }));
```

(These paths have empty `q`, so no highlight and score 0 — `byId`/`loadDocs` for them is now unused; see Step 3.)

- [ ] **Step 2: Replace the main text/rank hit builder (lines 320-332)**

Replace:

```ts
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
```

with:

```ts
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
  return { id, score: rawScore(id), highlight };
});
```

- [ ] **Step 3: Remove now-dead `byId`/`loadDocs` in the three lean-browse paths**

In each of the three lean-browse blocks, the `const byId = await loadDocs(...)` line directly above the hit builder is now unused. Delete that line in each of the three blocks (lines ~107, ~120, ~152). Leave `loadDocs` itself defined (still used by the text/filter/rank paths via `storedOf`).

- [ ] **Step 4: Run the full search test file**

Run: `npx vitest run src/component/search.test.ts`
Expected: the new id-shape test PASSES; any pre-existing test asserting `hits[0].document` now FAILS (fixed in Task 3).

---

### Task 3: Fix existing search tests that assert on `document`

**Files:**
- Modify: `src/component/search.test.ts` and any other `*.test.ts` asserting `hits[...].document` or `.text_match`

- [ ] **Step 1: Find all affected assertions**

Run: `grep -rn "\.document\b\|text_match" src/component/*.test.ts`

- [ ] **Step 2: Rewrite each assertion**

For each match, replace document-content assertions with id assertions. Pattern:
- `expect(r.hits[0].document.title).toBe("x")` → assert on the id instead: `expect(r.hits[0].id).toBe("<that doc's id>")`.
- `expect(r.hits.map(h => h.document.name))` → `expect(r.hits.map(h => h.id))`.
- `hits[0].text_match` → `hits[0].score`.

Where a test genuinely needed document *content* to prove ordering, assert on the **order of ids** (the test seeds known ids → known order).

- [ ] **Step 3: Run the whole component test suite**

Run: `npx vitest run src/component`
Expected: PASS (all green).

- [ ] **Step 4: Commit**

```bash
git add src/component/types.ts src/component/search.ts src/component/*.test.ts
git commit -m "feat(search): return { id, score, highlight } instead of document snapshot

Search no longer ships hit contents; callers hydrate by id. Highlight
retained (computed from index-relevant searchField text).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Update the example app to hydrate by id

**Files:**
- Modify: `example/convex/products.ts` (`benchmark` line 329; add hydrate helper; `searchProducts` returns hydrated hits)

- [ ] **Step 1: Add a hydrate helper in `example/convex/products.ts`**

The example currently has no app-owned products table — the component WAS the store. For the example we hydrate from the component's own `getCollection`-style read is not possible (it no longer returns docs). Simplest faithful demo: keep a thin app table. Add near the top:

```ts
// The app owns the serving copy; the component owns only the index.
// (schema.ts must declare a `productDocs` table: { docId: string, doc: any }
//  with index by_docId on ["docId"].)
async function hydrate(ctx: QueryCtx, hits: { id: string; score: number; highlight: any }[]) {
  const rows = await Promise.all(
    hits.map((h) =>
      ctx.db.query("productDocs").withIndex("by_docId", (q) => q.eq("docId", h.id)).unique(),
    ),
  );
  return hits.map((h, i) => ({ ...h, document: rows[i]?.doc ?? null })); // preserve order
}
```

- [ ] **Step 2: Add the `productDocs` table to the example schema**

In `example/convex/schema.ts`, add:

```ts
productDocs: defineTable({ docId: v.string(), doc: v.any() }).index("by_docId", ["docId"]),
```

- [ ] **Step 3: Write the serving copy alongside every component upsert**

In `seed` and `seedChain`, after each `search.upsertMany(...)`, also write the app copy. In `seed`:

```ts
for (const s of SAMPLE) {
  const existing = await ctx.db.query("productDocs").withIndex("by_docId", (q) => q.eq("docId", s.id)).unique();
  if (existing) await ctx.db.patch(existing._id, { doc: s });
  else await ctx.db.insert("productDocs", { docId: s.id, doc: s });
}
```

(In `seedChain`, do the same loop over `generateRange(...)`'s docs, using `d.id`/`d.doc`.)

- [ ] **Step 4: Hydrate in `searchProducts`**

Change the handler (line 294-295):

```ts
handler: async (ctx, args) => {
  const r = await search.search(ctx, { collection: COLLECTION, ...args });
  return { ...r, hits: await hydrate(ctx, r.hits) };
},
```

- [ ] **Step 5: Fix `benchmark`'s top-result read (line 329)**

Replace `top: r.hits[0]?.document?.name` with `top: r.hits[0]?.document?.name` still works **because `searchProducts` now hydrates** — verify it reads through the hydrated shape. No change needed if benchmark calls `searchProducts` (it does, line 324).

- [ ] **Step 6: Typecheck the example**

Run: `cd example && npx tsc -p convex/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add example/convex/products.ts example/convex/schema.ts
git commit -m "example: hydrate search hits by id from app-owned productDocs table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review notes

- Spec coverage: result shape `{id,score,highlight}` (Task 1-2), highlight retained (Task 2), app hydration preserving order (Task 4 `hydrate`). ✓
- The three lean-browse paths return `score: 0` (browse has no relevance) — matches spec ("0 in browse").
- `loadDocs` stays (used by text/filter/rank paths for `storedOf`, which feeds highlight + re-rank). Only the three lean-browse `byId` locals are removed.
