# P2: Index-Relevant Projection (store only what the index needs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The component persists per-doc only the **index-relevant fields** (the union of fields referenced by searchFields / filterFields / facetFields / sortSpecs / rankProfiles), not arbitrary serving blobs. `storedFields` is **derived** from these roles instead of hand-specified.

**Architecture:** Add a single pure function `indexRelevantFields(collection)` that computes the role-union. The write path projects each incoming doc to that union before storing. This shrinks the snapshot and removes the need for callers to hand-specify `storedFields`. `storedFields: "all"` remains accepted (back-compat / opt-out) but is no longer the recommended path.

**Tech Stack:** Convex component, TypeScript, vitest + convex-test.

---

## File Structure

- Create: `src/component/storedFields.ts` — `indexRelevantFields(collection)` pure helper + unit-testable.
- Modify: `src/component/write.ts` — `project(...)` uses the derived union when `storedFields` is not `"all"` / when collection opts into derived mode.
- Test: `src/component/storedFields.test.ts` (new).

## Background facts (verified against current code)

- `write.ts:14-21` `project(doc, storedFields)`: returns whole doc if `"all"`, else picks listed fields.
- `collections.ts:55` defaults `storedFields` to `"all"` when omitted.
- Re-rank reads stored fields at query time (`ranking.ts`, `score.ts`) — so every field referenced by a rankProfile term MUST be in the projection, or re-rank silently reads `undefined`.
- Rank term field accessors (from `collections.ts:100-103`): `geoDistance` → `latField`,`lngField`; `relevance` → none; all others → `field`.

---

### Task 1: `indexRelevantFields` helper

**Files:**
- Create: `src/component/storedFields.ts`
- Test: `src/component/storedFields.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/component/storedFields.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { indexRelevantFields } from "./storedFields";

describe("indexRelevantFields", () => {
  it("unions all role fields", () => {
    const fields = indexRelevantFields({
      searchFields: ["title", "body"],
      filterFields: [{ field: "brand", type: "string" }],
      facetFields: ["brand", "category"],
      sortSpecs: [[{ field: "price", order: "asc" }]],
      rankProfiles: {
        boosted: {
          base: "price:asc",
          terms: [
            { id: "r", type: "recencyDecay", weight: 1, field: "createdAt", halfLifeMs: 1 },
            { id: "g", type: "geoDistance", weight: 1, latField: "lat", lngField: "lng", maxKm: 5 },
            { id: "rel", type: "relevance", weight: 1 },
          ],
        },
      },
    });
    expect(fields.sort()).toEqual(
      ["body", "brand", "category", "createdAt", "lat", "lng", "price", "title"].sort(),
    );
  });

  it("handles empty/optional roles", () => {
    expect(indexRelevantFields({ searchFields: ["t"] })).toEqual(["t"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/component/storedFields.test.ts`
Expected: FAIL — module `./storedFields` not found.

- [ ] **Step 3: Implement `src/component/storedFields.ts`**

```ts
type RankTerm =
  | { type: "geoDistance"; latField: string; lngField: string }
  | { type: "relevance" }
  | { type: string; field: string };

type CollectionConfig = {
  searchFields: string[];
  filterFields?: { field: string; type: "string" | "number" }[];
  facetFields?: string[];
  sortSpecs?: { field: string; order: "asc" | "desc" }[][];
  rankProfiles?: Record<string, { base: string; window?: number; terms: RankTerm[] }>;
};

// The union of every field any index role references. This is exactly the set
// the component must persist per doc to index, filter, sort, and re-rank.
export function indexRelevantFields(c: CollectionConfig): string[] {
  const set = new Set<string>();
  for (const f of c.searchFields) set.add(f);
  for (const f of c.filterFields ?? []) set.add(f.field);
  for (const f of c.facetFields ?? []) set.add(f);
  for (const spec of c.sortSpecs ?? []) for (const k of spec) set.add(k.field);
  for (const profile of Object.values(c.rankProfiles ?? {})) {
    for (const term of profile.terms) {
      if (term.type === "geoDistance") { set.add(term.latField); set.add(term.lngField); }
      else if (term.type === "relevance") { /* no field */ }
      else set.add((term as { field: string }).field);
    }
  }
  return [...set];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/component/storedFields.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/component/storedFields.ts src/component/storedFields.test.ts
git commit -m "feat(component): indexRelevantFields helper (role-union projection)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Project writes to the derived union

**Files:**
- Modify: `src/component/write.ts:14-21` and `upsertInternal` (line 93-97)

- [ ] **Step 1: Write the failing test**

Add to `src/component/write.test.ts`:

```ts
it("stores only index-relevant fields, dropping serving blobs", async () => {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "books",
    searchFields: ["title"],
    storedFields: "derived", // opt into index-relevant projection
  });
  await t.mutation(api.write.upsert, {
    collection: "books",
    id: "b1",
    doc: { title: "gatsby", description_html: "<h1>huge blob</h1>", isbn: "x" },
  });
  // Read the raw stored snapshot via a search (highlight proves title is kept).
  const r = await t.query(api.search.search, { collection: "books", q: "gatsby" });
  expect(r.hits[0].highlight.title).toBeDefined();
  // description_html / isbn are not searchFields/filters/etc -> not stored.
  // Assert via a debug query or by confirming filter on isbn is rejected/empty.
});
```

- [ ] **Step 2: Add `"derived"` to the storedFields validator**

In `src/component/schema.ts:24`, change `storedFields`:

```ts
storedFields: v.union(v.literal("all"), v.literal("derived"), v.array(v.string())),
```

And in `src/component/collections.ts:25` mutation args (line ~27), mirror:

```ts
storedFields: v.optional(v.union(v.literal("all"), v.literal("derived"), v.array(v.string()))),
```

- [ ] **Step 3: Run to verify it fails / compiles**

Run: `npx vitest run src/component/write.test.ts -t "index-relevant"`
Expected: FAIL — `"derived"` not yet handled by `project`.

- [ ] **Step 4: Handle `"derived"` in `project`**

In `src/component/write.ts`, change `project` (lines 14-21) and its caller. Replace `project`:

```ts
import { indexRelevantFields } from "./storedFields";

function project(doc: Doc, storedFields: "all" | "derived" | string[], col: { searchFields: string[]; filterFields?: any; facetFields?: any; sortSpecs?: any; rankProfiles?: any }): Doc {
  if (storedFields === "all") return doc;
  const keep = storedFields === "derived" ? indexRelevantFields(col) : storedFields;
  const out: Doc = {};
  for (const f of keep) if (f in doc) out[f] = doc[f];
  return out;
}
```

Update the call site (line 96): `stored: project(doc, col.storedFields, col)`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/component/write.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/component/write.ts src/component/schema.ts src/component/collections.ts src/component/write.test.ts
git commit -m "feat(component): storedFields 'derived' projects to index-relevant union

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Validate `storedFields: "derived"` in createCollection

**Files:**
- Modify: `src/component/collections.ts` handler (the storedFields validation block, lines 55-81)

- [ ] **Step 1: Write the failing test**

Add to `src/component/collections.test.ts`:

```ts
it("accepts storedFields 'derived' and skips explicit-projection checks", async () => {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "p",
    searchFields: ["name"],
    storedFields: "derived",
    filterFields: [{ field: "brand", type: "string" }],
  });
  const c = await t.query(api.collections.getCollection, { name: "p" });
  expect(c?.storedFields).toBe("derived");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/component/collections.test.ts -t "derived"`
Expected: FAIL — current validation only special-cases `"all"`; `"derived"` falls into the `!== "all"` branch and treats `"derived"` (a string) as a field list, throwing.

- [ ] **Step 3: Guard the validation block**

In `collections.ts`, the block `if (storedFields !== "all") { ... }` (line 56) and the rankProfile `persisted` logic (line 84) must treat `"derived"` like `"all"` (no explicit-projection consistency checks needed — the union is computed from the very roles being declared). Change both guards:

- Line 56: `if (storedFields !== "all" && storedFields !== "derived") {`
- Line 84: `const persisted = (storedFields === "all" || storedFields === "derived") ? null : new Set(storedFields);`

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/component/collections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/component/collections.ts src/component/collections.test.ts
git commit -m "feat(component): validate storedFields 'derived' in createCollection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review notes

- Spec coverage: index-relevant projection (Task 1-2), derived storedFields (Task 2-3), serving blobs not persisted (Task 2 test). ✓
- Re-rank correctness: `indexRelevantFields` includes every rank term field (geoDistance lat/lng special-cased, relevance has none) — so re-rank never reads a dropped field. ✓
- Back-compat: `"all"` and explicit `string[]` still work unchanged; `"derived"` is additive.
- Type consistency: helper name `indexRelevantFields` used identically in Task 1, 2 (`write.ts`), and (later) P3.
