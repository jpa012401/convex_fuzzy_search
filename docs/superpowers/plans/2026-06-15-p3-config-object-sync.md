# P3: Config Object + `sync` (declarative collection setup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the app declare collections as a config object on the `FuzzySearch` client and call `client.sync(ctx)` once (post-deploy) to auto-apply changes: metadata changes are O(1) overwrites; structural additions update the row and mark added fields "pending" reindex; removals leave dead rows (lazy).

**Architecture:** The client constructor accepts `{ collections }`. A pure `diffCollection(stored, config)` classifies each field change as `metadata` / `structuralAdd` / `removal` / `create`. `sync` iterates the config, runs the existing `createCollection` validation, and writes via a new component mutation `applyCollectionConfig` that upserts the `collections` row and records pending fields. No documents are read by sync.

**Tech Stack:** Convex component, TypeScript, vitest + convex-test.

---

## File Structure

- Create: `src/component/diffCollection.ts` — pure diff/classify helper (unit-tested without convex).
- Modify: `src/component/schema.ts` — add `pendingFields` to the `collections` table.
- Create: `src/component/configSync.ts` — `applyCollectionConfig` mutation (upsert row + set pending).
- Modify: `src/client/index.ts` — constructor `{ collections }` option; `sync(ctx)` method.
- Test: `src/component/diffCollection.test.ts`, `src/client/sync.test.ts`.

## Background facts (verified against current code)

- `FuzzySearch` constructor today (`src/client/index.ts:39-40`): `constructor(public component: ComponentApi) {}`.
- `createCollection` (`collections.ts:24`) holds all validation; `getCollection` (line 124) returns the row or null.
- `collections` table fields (`schema.ts:20-45`): name, searchFields, storedFields, filterFields?, facetFields?, sortSpecs?, rankProfiles?.

---

### Task 1: `diffCollection` pure classifier

**Files:**
- Create: `src/component/diffCollection.ts`
- Test: `src/component/diffCollection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/component/diffCollection.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { diffCollection } from "./diffCollection";

const base = {
  searchFields: ["title"],
  storedFields: "derived" as const,
  filterFields: [{ field: "brand", type: "string" as const }],
  facetFields: ["brand"],
  sortSpecs: [[{ field: "price", order: "asc" as const }]],
  rankProfiles: {},
};

describe("diffCollection", () => {
  it("create when stored is null", () => {
    expect(diffCollection(null, base).kind).toBe("create");
  });
  it("metadata-only when rankProfiles change", () => {
    const d = diffCollection(base, { ...base, rankProfiles: { x: { base: "price:asc", terms: [] } } });
    expect(d.kind).toBe("update");
    expect(d.pendingFields).toEqual([]);
  });
  it("structural add flags the new filter field as pending", () => {
    const d = diffCollection(base, {
      ...base,
      filterFields: [...base.filterFields, { field: "color", type: "string" as const }],
    });
    expect(d.kind).toBe("update");
    expect(d.pendingFields).toContain("color");
  });
  it("structural add flags a new facet field", () => {
    const d = diffCollection(base, { ...base, facetFields: ["brand", "size"] });
    expect(d.pendingFields).toContain("size");
  });
  it("structural add flags a new sortSpec field", () => {
    const d = diffCollection(base, {
      ...base,
      sortSpecs: [...base.sortSpecs, [{ field: "rating", order: "desc" as const }]],
    });
    expect(d.pendingFields).toContain("rating");
  });
  it("removal is not pending (lazy)", () => {
    const d = diffCollection(base, { ...base, filterFields: [] });
    expect(d.pendingFields).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/component/diffCollection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/component/diffCollection.ts`**

```ts
type FilterField = { field: string; type: "string" | "number" };
type SortKey = { field: string; order: "asc" | "desc" };
export type CollectionConfig = {
  searchFields: string[];
  storedFields: "all" | "derived" | string[];
  filterFields?: FilterField[];
  facetFields?: string[];
  sortSpecs?: SortKey[][];
  rankProfiles?: Record<string, { base: string; window?: number; terms: unknown[] }>;
};

export type CollectionDiff =
  | { kind: "create"; pendingFields: string[] }
  | { kind: "update"; pendingFields: string[] }
  | { kind: "noop"; pendingFields: [] };

// Fields newly indexed by a structural role (filter/facet/sort) require existing
// docs to be reindexed -> "pending". Search-field and rankProfile changes are
// metadata-only (no per-doc index rows keyed by those). Removals are lazy.
export function diffCollection(stored: CollectionConfig | null, config: CollectionConfig): CollectionDiff {
  if (stored === null) {
    return { kind: "create", pendingFields: structuralFields(config) };
  }
  const before = new Set(structuralFields(stored));
  const added = structuralFields(config).filter((f) => !before.has(f));
  return { kind: "update", pendingFields: added };
}

function structuralFields(c: CollectionConfig): string[] {
  const set = new Set<string>();
  for (const f of c.filterFields ?? []) set.add(f.field);
  for (const f of c.facetFields ?? []) set.add(f);
  for (const spec of c.sortSpecs ?? []) for (const k of spec) set.add(k.field);
  return [...set];
}
```

(For `create`, every structural field is "pending" only if docs already exist; sync decides whether to surface that — a brand-new collection has no docs, so the example app simply never has pending on create. The pendingFields list is still computed for uniformity.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/component/diffCollection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/component/diffCollection.ts src/component/diffCollection.test.ts
git commit -m "feat(component): diffCollection classifier (metadata vs structural-add)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add `pendingFields` to the schema + `applyCollectionConfig` mutation

**Files:**
- Modify: `src/component/schema.ts:20-45` (add `pendingFields`)
- Create: `src/component/configSync.ts`

- [ ] **Step 1: Write the failing test**

Create `src/component/configSync.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob("./**/*.ts");

describe("applyCollectionConfig", () => {
  it("creates a collection row from config", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "p", searchFields: ["name"], storedFields: "derived" },
    });
    const c = await t.query(api.collections.getCollection, { name: "p" });
    expect(c).toMatchObject({ name: "p", storedFields: "derived" });
  });

  it("updates metadata in place without touching pendingFields", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "p", searchFields: ["name"], storedFields: "derived" },
    });
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "p", searchFields: ["name", "desc"], storedFields: "derived" },
    });
    const c = await t.query(api.collections.getCollection, { name: "p" });
    expect(c?.searchFields).toEqual(["name", "desc"]);
    expect(c?.pendingFields ?? []).toEqual([]);
  });

  it("records pending fields when a filter field is added", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "p", searchFields: ["name"], storedFields: "derived" },
    });
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "p", searchFields: ["name"], storedFields: "derived", filterFields: [{ field: "brand", type: "string" }] },
    });
    const c = await t.query(api.collections.getCollection, { name: "p" });
    expect(c?.pendingFields).toContain("brand");
  });
});
```

- [ ] **Step 2: Add `pendingFields` to schema**

In `src/component/schema.ts`, inside `collections: defineTable({ ... })` add before `.index`:

```ts
    pendingFields: v.optional(v.array(v.string())),
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/component/configSync.test.ts`
Expected: FAIL — `api.configSync.applyCollectionConfig` does not exist.

- [ ] **Step 4a: Extract shared validation from `createCollection` (DRY)**

In `src/component/collections.ts`, factor the validation body of `createCollection`'s handler (the storedFields-consistency block at lines 55-81 and the rankProfiles block at 82-111) into an exported pure function so both `createCollection` and `applyCollectionConfig` call it:

```ts
export function validateCollectionConfig(args: {
  storedFields: "all" | "derived" | string[];
  searchFields: string[];
  filterFields?: { field: string; type: "string" | "number" }[];
  facetFields?: string[];
  sortSpecs?: { field: string; order: "asc" | "desc" }[][];
  rankProfiles?: Record<string, { base: string; terms: any[] }>;
}) {
  // ... move the two existing validation blocks here verbatim, treating
  // "derived" like "all" (no explicit-projection consistency checks). ...
}
```

Then in `createCollection`'s handler, replace the inlined blocks with a single `validateCollectionConfig({ ...args, storedFields });` call. Run `npx vitest run src/component/collections.test.ts` to confirm createCollection behavior is unchanged.

- [ ] **Step 4: Implement `src/component/configSync.ts`**

```ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { loadCollection, validateCollectionConfig } from "./collections";
import { diffCollection } from "./diffCollection";
import { rankProfileValidator } from "./schema";

const configValidator = v.object({
  name: v.string(),
  searchFields: v.array(v.string()),
  storedFields: v.optional(v.union(v.literal("all"), v.literal("derived"), v.array(v.string()))),
  filterFields: v.optional(v.array(v.object({ field: v.string(), type: v.union(v.literal("string"), v.literal("number")) }))),
  facetFields: v.optional(v.array(v.string())),
  sortSpecs: v.optional(v.array(v.array(v.object({ field: v.string(), order: v.union(v.literal("asc"), v.literal("desc")) })))),
  rankProfiles: v.optional(v.record(v.string(), rankProfileValidator)),
});

// Idempotent upsert of a collection row from declarative config. Computes which
// structural fields are newly added (pendingFields) so the app can reindex.
// Metadata changes apply in place. Does NOT read documents.
export const applyCollectionConfig = mutation({
  args: { config: configValidator },
  handler: async (ctx, { config }) => {
    const storedFields = config.storedFields ?? "derived";
    validateCollectionConfig({ ...config, storedFields });
    const stored = await loadCollection(ctx, config.name);
    const next = {
      name: config.name,
      searchFields: config.searchFields,
      storedFields,
      filterFields: config.filterFields,
      facetFields: config.facetFields,
      sortSpecs: config.sortSpecs,
      rankProfiles: config.rankProfiles,
    };
    const diff = diffCollection(
      stored ? { ...stored, storedFields: stored.storedFields } : null,
      { ...next, storedFields },
    );
    if (stored === null) {
      // Brand-new collection: no existing docs, so nothing is pending.
      await ctx.db.insert("collections", { ...next, pendingFields: [] });
      return { kind: "create", pendingFields: [] as string[] };
    }
    const pending = [...new Set([...(stored.pendingFields ?? []), ...diff.pendingFields])];
    await ctx.db.patch(stored._id, { ...next, pendingFields: pending });
    return { kind: "update", pendingFields: pending };
  },
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/component/configSync.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/component/schema.ts src/component/configSync.ts src/component/configSync.test.ts
git commit -m "feat(component): applyCollectionConfig mutation + pendingFields tracking

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Client constructor `{ collections }` option + `sync(ctx)`

**Files:**
- Modify: `src/client/index.ts:39-66`

- [ ] **Step 1: Write the failing test**

Create `src/client/sync.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { registerAggregate } from "@convex-dev/aggregate/test";
import schema from "../component/schema";
import { api } from "../component/_generated/api";
import { FuzzySearch } from "./index";
const modules = import.meta.glob("../component/**/*.ts");

it("sync applies the configured collections", async () => {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  const search = new FuzzySearch(/* component ref injected by test harness */ (api as any), {
    collections: {
      products: { searchFields: ["name"], filterFields: [{ field: "brand", type: "string" }] },
    },
  });
  // Drive sync through a mutation context provided by convex-test:
  await t.run(async (ctx) => { await search.sync(ctx as any); });
  const c = await t.query(api.collections.getCollection, { name: "products" });
  expect(c).toMatchObject({ name: "products" });
});
```

NOTE: if `t.run` cannot supply a `runMutation`-capable ctx in this harness, instead test `applyCollectionConfig` directly (Task 2 already does) and test the client's config→args mapping as a pure unit by asserting `search.configEntries()` returns the normalized config array. Prefer the pure-unit test if the harness ctx is insufficient.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/client/sync.test.ts`
Expected: FAIL — constructor takes one arg; `sync` undefined.

- [ ] **Step 3: Add the constructor option + `sync`**

In `src/client/index.ts`, change the constructor and add `sync`:

```ts
type CollectionConfigInput = {
  searchFields: string[];
  storedFields?: "all" | "derived" | string[];
  filterFields?: { field: string; type: "string" | "number" }[];
  facetFields?: string[];
  sortSpecs?: { field: string; order: "asc" | "desc" }[][];
  rankProfiles?: Record<string, { base: string; window?: number; terms: any[] }>;
};

export class FuzzySearch {
  constructor(
    public component: ComponentApi,
    private options?: { collections?: Record<string, CollectionConfigInput> },
  ) {}

  // Normalize the configured collections into applyCollectionConfig args.
  configEntries() {
    const cols = this.options?.collections ?? {};
    return Object.entries(cols).map(([name, c]) => ({
      name,
      searchFields: c.searchFields,
      storedFields: c.storedFields ?? "derived",
      filterFields: c.filterFields,
      facetFields: c.facetFields,
      sortSpecs: c.sortSpecs,
      rankProfiles: c.rankProfiles,
    }));
  }

  // Auto-apply: reconcile every configured collection's row to match code.
  // O(1) per collection (no document reads). Returns pending fields per collection.
  async sync(ctx: MutationCtx) {
    const results: { name: string; pendingFields: string[] }[] = [];
    for (const config of this.configEntries()) {
      const r = await ctx.runMutation(this.component.configSync.applyCollectionConfig, { config });
      results.push({ name: config.name, pendingFields: r.pendingFields });
    }
    return results;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/client/sync.test.ts`
Expected: PASS (or, if using the pure-unit fallback, assert `search.configEntries()` shape).

- [ ] **Step 5: Typecheck the package**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/index.ts src/client/sync.test.ts
git commit -m "feat(client): config object + sync() to auto-apply collection config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Migrate the example app to config + sync

**Files:**
- Modify: `example/convex/products.ts` (replace `createProductsCollection` calls with config + a `sync` mutation)

- [ ] **Step 1: Move the field declarations into the client config**

Replace the `new FuzzySearch(components.fuzzySearch)` line (products.ts:7) with:

```ts
const search = new FuzzySearch(components.fuzzySearch, {
  collections: {
    products: {
      searchFields: ["name", "description", "brand", "category"],
      storedFields: "derived",
      filterFields: FILTER_FIELDS,
      facetFields: FACET_FIELDS,
      sortSpecs: SORT_SPECS,
      rankProfiles: RANK_PROFILES,
    },
  },
});
```

(Keep `FILTER_FIELDS` / `FACET_FIELDS` / `SORT_SPECS` / `RANK_PROFILES` consts; they're referenced above the constructor now — move those const declarations above line 7.)

- [ ] **Step 2: Add a `sync` mutation**

Add to `example/convex/products.ts`:

```ts
export const sync = mutation({
  args: {},
  handler: async (ctx) => search.sync(ctx),
});
```

- [ ] **Step 3: Replace `createProductsCollection(ctx)` callers with `search.sync(ctx)`**

In `seed`, `startSeed`: replace `await createProductsCollection(ctx)` with `await search.sync(ctx)`. Delete the now-unused `createProductsCollection` function. The `seed` drop-and-recreate logic can keep using `deleteCollection` then `search.sync(ctx)`.

- [ ] **Step 4: Typecheck the example**

Run: `cd example && npx tsc -p convex/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add example/convex/products.ts
git commit -m "example: declare products collection via config + sync()

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review notes

- Spec coverage: config object source of truth (Task 3), explicit sync O(1) (Task 3), metadata vs structural classification (Task 1), pendingFields tracking (Task 2), lazy removals (Task 1 test). ✓
- `applyCollectionConfig` runs no document reads → sync is O(1)/collection. ✓
- Validation: Task 2 Step 4a extracts `validateCollectionConfig` from `createCollection` and `applyCollectionConfig` calls it — shared, not duplicated (DRY). ✓
- Type consistency: `storedFields` union `"all" | "derived" | string[]` matches P2; `configEntries`/`sync` names stable.
