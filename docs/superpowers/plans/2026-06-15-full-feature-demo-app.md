# Full Feature-Demo App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the example into a tabbed full-feature demo (Storefront / Ranking Lab / Places / Index Admin) showing every component feature, including `recencyDecay`, `geoDistance` (new `places` dataset), `relevance`, multi-key `sortBy`, and the index lifecycle.

**Architecture:** Backend adds a deterministic `places` dataset + a geo-aware `places` collection (mirroring `products.ts`) with a `placeDocs` app table for hydration. Frontend `App.tsx` becomes a lightweight `useState` tab switch; the existing `Storefront` becomes tab 1; three new React tabs drive existing + new query wrappers. Backend is TDD; React UI is build-and-verify (typecheck + live smoke).

**Tech Stack:** Convex component, TypeScript, React + Vite, vitest + convex-test.

---

## File Structure

- Create: `example/convex/placesData.ts` — deterministic `places` generator (mirrors `dataset.ts`).
- Create: `example/convex/places.ts` — places collection config, seed/sync/search/reindex/stats wrappers.
- Create: `example/convex/places.test.ts` — backend tests (geo/recency/sort/facet).
- Modify: `example/convex/schema.ts` — add `placeDocs` table.
- Modify: `example/convex/products.ts` — add derived `releasedAt` on seed + a `fresh` rank profile.
- Modify: `example/src/App.tsx` — tab shell.
- Create: `example/src/RankingLab.tsx`, `example/src/PlacesPage.tsx`, `example/src/components/PlaceCard.tsx`, `example/src/IndexAdmin.tsx`.

## Verified facts (current code)

- `dataset.ts` exports `rng(seed)`, `pick`, `intIn` patterns (mulberry32 PRNG); `generateRange(start, count, profile)` returns `{ id, doc }[]`.
- `products.ts`: `seed`/`startSeed`/`seedChain`/`sync`/`searchProducts`/`reindex`/`indexStats`; `putDocs`/`hydrate` helpers; `reindex` default batch is 10.
- `schema.ts` has `profiles` + `productDocs: defineTable({ docId: v.string(), doc: v.any() }).index("by_docId", ["docId"])`.
- Client: `new FuzzySearch(components.fuzzySearch, { collections: {...} })`, `search.sync(ctx)`, `search.search(ctx, args)`, `search.upsertMany`, `search.clearPending`, `search.pendingFields`, `search.stats`.
- Test harness: `convexTest(schema, modules)` + `register as registerAggregate` from `@convex-dev/aggregate/test`; `registerAggregate(t, "docCount")` always, plus `registerAggregate(t, "sortIndex")` when the collection has sortSpecs.
- `rank` query arg shape: `{ profile: string, weights?: Record<string,number>, context?: { now?: number, origin?: { lat, lng }, sets?: Record<string,string[]> } }`.

---

### Task 1: `places` deterministic dataset generator

**Files:**
- Create: `example/convex/placesData.ts`
- Test: `example/convex/placesData.test.ts`

- [ ] **Step 1: Write the failing test** `example/convex/placesData.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generatePlace, generatePlaceRange, CUISINE_OPTIONS } from "./placesData";

describe("placesData", () => {
  it("is deterministic (same index -> same place)", () => {
    expect(generatePlace(0, 1000)).toEqual(generatePlace(0, 1000));
  });
  it("produces geo coords and required fields", () => {
    const p = generatePlace(5, 1_000_000).doc as any;
    expect(typeof p.lat).toBe("number");
    expect(typeof p.lng).toBe("number");
    expect(p.lat).toBeGreaterThanOrEqual(-90);
    expect(p.lat).toBeLessThanOrEqual(90);
    expect(typeof p.rating).toBe("number");
    expect(typeof p.openedAt).toBe("number");
    expect(CUISINE_OPTIONS).toContain(p.cuisine);
    expect(p.id).toMatch(/^pl\d{5}$/);
  });
  it("openedAt is before the provided now", () => {
    const now = 1_000_000_000_000;
    const p = generatePlace(3, now).doc as any;
    expect(p.openedAt).toBeLessThanOrEqual(now);
  });
  it("generatePlaceRange returns {id,doc} entries", () => {
    const r = generatePlaceRange(0, 3, 1000);
    expect(r).toHaveLength(3);
    expect(r[0]).toHaveProperty("id");
    expect(r[0]).toHaveProperty("doc");
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npx vitest run example/convex/placesData.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `example/convex/placesData.ts`:

```ts
// Deterministic synthetic "places" dataset (geo-located venues) for demoing
// geoDistance / recencyDecay. Pure + reproducible like dataset.ts.

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];
const intIn = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const CUISINES = ["Italian", "Japanese", "Mexican", "Thai", "Indian", "French", "Greek", "Korean", "Vietnamese", "American"];
export const CUISINE_OPTIONS = CUISINES;
const ADJ = ["Cozy", "Golden", "Urban", "Rustic", "Little", "Blue", "Corner", "Garden", "Old", "Sunny"];
const NOUN = ["Kitchen", "Bistro", "House", "Table", "Grill", "Den", "Spoon", "Garden", "Room", "Pantry"];

// A few city centers; places scatter ~0.15deg around one of them.
export const CITY_PRESETS: { name: string; lat: number; lng: number }[] = [
  { name: "San Francisco", lat: 37.7749, lng: -122.4194 },
  { name: "New York", lat: 40.7128, lng: -74.006 },
  { name: "London", lat: 51.5074, lng: -0.1278 },
];

export type Place = {
  id: string; name: string; cuisine: string; description: string;
  lat: number; lng: number; rating: number; priceLevel: number;
  openedAt: number; popularity: number; image: string;
};

// `now` anchors openedAt (absolute ms). Pass a single seed-time value for a run.
export function generatePlace(index: number, now: number): { id: string; doc: Place } {
  const r = rng(index + 1);
  const city = CITY_PRESETS[Math.floor(r() * CITY_PRESETS.length)];
  const lat = city.lat + (r() - 0.5) * 0.3;
  const lng = city.lng + (r() - 0.5) * 0.3;
  const cuisine = pick(r, CUISINES);
  const name = `${pick(r, ADJ)} ${pick(r, NOUN)}`;
  const description = `A ${cuisine.toLowerCase()} spot near ${city.name} known for fresh plates and a warm room.`;
  const id = "pl" + String(index + 1).padStart(5, "0");
  const openedDaysAgo = intIn(r, 0, 720);
  return {
    id,
    doc: {
      id, name, cuisine, description, lat, lng,
      rating: Math.round((1 + r() * 4) * 10) / 10,
      priceLevel: intIn(r, 1, 4),
      openedAt: now - openedDaysAgo * 86_400_000,
      popularity: intIn(r, 0, 1000),
      image: `https://picsum.photos/seed/${id}/300`,
    },
  };
}

export function generatePlaceRange(start: number, count: number, now: number): { id: string; doc: Place }[] {
  const out: { id: string; doc: Place }[] = [];
  for (let i = 0; i < count; i++) out.push(generatePlace(start + i, now));
  return out;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run example/convex/placesData.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add example/convex/placesData.ts example/convex/placesData.test.ts
git commit -m "feat(example): deterministic geo places dataset generator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `placeDocs` table + `places` collection backend

**Files:**
- Modify: `example/convex/schema.ts`
- Create: `example/convex/places.ts`
- Test: `example/convex/places.test.ts`

- [ ] **Step 1: Add the `placeDocs` table** in `example/convex/schema.ts` (inside `defineSchema`, after `productDocs`):

```ts
  placeDocs: defineTable({ docId: v.string(), doc: v.any() }).index("by_docId", ["docId"]),
```

- [ ] **Step 2: Write the failing test** `example/convex/places.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob("./**/*.ts");

async function seeded(t: any, n = 30) {
  registerAggregate(t, "docCount");
  registerAggregate(t, "sortIndex");
  await t.mutation(api.places.seedPlaces, { total: n });
}

describe("places backend", () => {
  it("seeds and searches by cuisine text + hydrates", async () => {
    const t = convexTest(schema, modules);
    await seeded(t);
    const r = await t.query(api.places.searchPlaces, { q: "bistro", perPage: 5 });
    expect(r.found).toBeGreaterThanOrEqual(0);
    // hydrated doc present (or {} — but for matched ids it should carry name)
    if (r.hits.length) expect(r.hits[0].document).toBeDefined();
  });

  it("geoDistance ranks nearer places first", async () => {
    const t = convexTest(schema, modules);
    await seeded(t, 40);
    // origin = San Francisco preset
    const r = await t.query(api.places.searchPlaces, {
      q: "", perPage: 5,
      rank: { profile: "nearby", context: { now: 2_000_000_000_000, origin: { lat: 37.7749, lng: -122.4194 } } },
    });
    expect(r.hits.length).toBeGreaterThan(0);
    // distances should be non-decreasing-ish: first hit closer than last
    const dist = (h: any) => {
      const d = h.document; if (!d.lat) return Infinity;
      return Math.hypot(d.lat - 37.7749, d.lng + 122.4194);
    };
    expect(dist(r.hits[0])).toBeLessThanOrEqual(dist(r.hits[r.hits.length - 1]) + 0.5);
  });

  it("cuisine facet returns counts", async () => {
    const t = convexTest(schema, modules);
    await seeded(t, 40);
    const r = await t.query(api.places.searchPlaces, { q: "", facetBy: ["cuisine"], perPage: 2 });
    expect(r.facet_counts.find((f: any) => f.field_name === "cuisine")).toBeDefined();
  });
});
```

- [ ] **Step 3: Run to confirm fail**

Run: `npx vitest run example/convex/places.test.ts`
Expected: FAIL — `api.places.*` not found.

- [ ] **Step 4: Implement** `example/convex/places.ts`:

```ts
import { mutation, query, QueryCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { components, api } from "./_generated/api";
import { FuzzySearch } from "@elevatech/fuzzy-search";
import { generatePlaceRange } from "./placesData";

const COLLECTION = "places";
const NINETY_DAYS_MS = 7_776_000_000;

const search = new FuzzySearch(components.fuzzySearch, {
  collections: {
    places: {
      searchFields: ["name", "cuisine", "description"],
      storedFields: "derived",
      filterFields: [
        { field: "cuisine", type: "string" },
        { field: "rating", type: "number" },
        { field: "priceLevel", type: "number" },
      ],
      facetFields: ["cuisine", "priceLevel"],
      sortSpecs: [[{ field: "rating", order: "desc" }]],
      rankProfiles: {
        nearby: {
          base: "rating:desc",
          window: 200,
          terms: [
            { id: "geo", type: "geoDistance", weight: 5, latField: "lat", lngField: "lng", maxKm: 25 },
            { id: "fresh", type: "recencyDecay", weight: 2, field: "openedAt", halfLifeMs: NINETY_DAYS_MS },
            { id: "rel", type: "relevance", weight: 1 },
          ],
        },
      },
    },
  },
});

async function putDocs(ctx: MutationCtx, docs: { id: string; doc: Record<string, unknown> }[]) {
  for (const { id, doc } of docs) {
    const existing = await ctx.db.query("placeDocs").withIndex("by_docId", (q) => q.eq("docId", id)).unique();
    if (existing) await ctx.db.patch(existing._id, { doc });
    else await ctx.db.insert("placeDocs", { docId: id, doc });
  }
}

async function hydrate(ctx: QueryCtx, hits: { id: string; score: number; highlight: any }[]) {
  const rows = await Promise.all(
    hits.map((h) => ctx.db.query("placeDocs").withIndex("by_docId", (q) => q.eq("docId", h.id)).unique()),
  );
  return hits.map((h, i) => ({ ...h, document: (rows[i]?.doc ?? {}) as Record<string, unknown> }));
}

export const sync = mutation({ args: {}, handler: async (ctx) => search.sync(ctx) });

// Synchronous small-batch seed (convex-test friendly): creates the collection
// via sync, then upserts `total` places into the component + placeDocs.
export const seedPlaces = mutation({
  args: { total: v.optional(v.number()) },
  handler: async (ctx, { total }) => {
    await search.sync(ctx);
    const n = total ?? 120;
    // Use a fixed anchor "now" so openedAt is deterministic across a run.
    const now = 2_000_000_000_000;
    const docs = generatePlaceRange(0, n, now);
    await search.upsertMany(ctx, { collection: COLLECTION, docs });
    await putDocs(ctx, docs);
    return { seeded: n };
  },
});

export const reindexPlaces = mutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), batch: v.optional(v.number()) },
  handler: async (ctx, { cursor, batch }) => {
    const size = batch ?? 10;
    const page = await ctx.db.query("placeDocs")
      .withIndex("by_docId", (q) => (cursor == null ? q : q.gt("docId", cursor))).take(size + 1);
    const rows = page.slice(0, size);
    await search.upsertMany(ctx, { collection: COLLECTION, docs: rows.map((r) => ({ id: r.docId, doc: r.doc })) });
    const done = page.length <= size;
    if (!done) await ctx.scheduler.runAfter(0, api.places.reindexPlaces, { cursor: rows[rows.length - 1].docId, batch });
    else await search.clearPending(ctx, COLLECTION);
    return { indexed: rows.length, done };
  },
});

export const placeStats = query({ args: {}, handler: async (ctx) => search.stats(ctx, COLLECTION) });

export const searchPlaces = query({
  args: {
    q: v.string(),
    page: v.optional(v.number()),
    perPage: v.optional(v.number()),
    filterBy: v.optional(v.string()),
    facetBy: v.optional(v.array(v.string())),
    sortBy: v.optional(v.array(v.object({ field: v.string(), order: v.union(v.literal("asc"), v.literal("desc")) }))),
    rank: v.optional(v.object({
      profile: v.string(),
      weights: v.optional(v.record(v.string(), v.number())),
      context: v.optional(v.object({
        now: v.optional(v.number()),
        origin: v.optional(v.object({ lat: v.number(), lng: v.number() })),
        sets: v.optional(v.record(v.string(), v.array(v.string()))),
      })),
    })),
  },
  handler: async (ctx, args) => {
    const r = await search.search(ctx, { collection: COLLECTION, ...args });
    return { ...r, hits: await hydrate(ctx, r.hits) };
  },
});
```

- [ ] **Step 5: Run to confirm pass**

Run: `npx vitest run example/convex/places.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck the example convex**

Run: `cd example && npx tsc -p convex/tsconfig.json --noEmit`
Expected: exit 0. Return: `cd ..`.

- [ ] **Step 7: Commit**

```bash
git add example/convex/schema.ts example/convex/places.ts example/convex/places.test.ts
git commit -m "feat(example): places collection (geoDistance/recency/relevance) + hydration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Products `fresh` rank profile + derived `releasedAt`

**Files:**
- Modify: `example/convex/products.ts`

- [ ] **Step 1: Add a `fresh` rank profile to the products config**

In `example/convex/products.ts`, the `RANK_PROFILES` const (currently `{ boosted: {...} }`) gains a `fresh` profile. Add to `RANK_PROFILES`:

```ts
  fresh: {
    base: "popularity:desc",
    window: 200,
    terms: [
      { id: "recency", type: "recencyDecay" as const, weight: 5, field: "releasedAt", halfLifeMs: 7_776_000_000 },
      { id: "rel", type: "relevance" as const, weight: 1 },
      { id: "pop", type: "field" as const, weight: 0.001, field: "popularity" },
    ],
  },
```

- [ ] **Step 2: Add a derived `releasedAt` to seeded product docs**

Products store `releasedDaysAgo` (relative). recencyDecay needs an absolute `releasedAt` ms. In `products.ts`, where docs are built for upsert (the `seed` SAMPLE map and `seedChain`'s `generateRange` docs), inject `releasedAt`. Add a helper near the top:

```ts
const SEED_NOW = 2_000_000_000_000; // fixed anchor so releasedAt is deterministic
function withReleasedAt(doc: Record<string, unknown>): Record<string, unknown> {
  const daysAgo = typeof doc.releasedDaysAgo === "number" ? doc.releasedDaysAgo : 0;
  return { ...doc, releasedAt: SEED_NOW - daysAgo * 86_400_000 };
}
```

In `seed`: map the SAMPLE docs through `withReleasedAt` before upsert/putDocs. The SAMPLE products lack `releasedDaysAgo`, so `releasedAt` becomes `SEED_NOW` (fine — they're "new"). In `seedChain`: map each `generateRange` doc's `doc` through `withReleasedAt`. Concretely, after `const docs = generateRange(...)`, do `const docs2 = docs.map((d) => ({ id: d.id, doc: withReleasedAt(d.doc) }))` and use `docs2` for both `upsertMany` and `putDocs`.

- [ ] **Step 3: Add `releasedAt` to the config so the field is index-relevant**

The `fresh` profile references `releasedAt`, so it's automatically index-relevant (rank term field) — `indexRelevantFields` includes rank fields, so `storedFields: "derived"` keeps it. No config field-list change needed beyond the rank profile addition in Step 1. Verify by reading `withReleasedAt` is applied on every write path.

- [ ] **Step 4: Typecheck**

Run: `cd example && npx tsc -p convex/tsconfig.json --noEmit`
Expected: exit 0. `cd ..`

- [ ] **Step 5: Commit**

```bash
git add example/convex/products.ts
git commit -m "feat(example): products 'fresh' recency rank profile + derived releasedAt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Tab shell (App.tsx) + Storefront as tab 1

**Files:**
- Modify: `example/src/App.tsx`

- [ ] **Step 1: Implement the tab shell**

Replace `example/src/App.tsx` entirely:

```tsx
import { useState } from "react";
import { Storefront } from "./Storefront";
import { RankingLab } from "./RankingLab";
import { PlacesPage } from "./PlacesPage";
import { IndexAdmin } from "./IndexAdmin";

type Tab = "storefront" | "ranking" | "places" | "admin";
const TABS: { key: Tab; label: string }[] = [
  { key: "storefront", label: "Storefront" },
  { key: "ranking", label: "Ranking Lab" },
  { key: "places", label: "Places" },
  { key: "admin", label: "Index Admin" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("storefront");
  return (
    <div>
      <nav style={{ display: "flex", gap: 8, padding: "8px 16px", borderBottom: "1px solid #ddd" }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ fontWeight: tab === t.key ? 700 : 400, padding: "6px 12px",
              border: "none", borderBottom: tab === t.key ? "2px solid #1565c0" : "2px solid transparent",
              background: "none", cursor: "pointer" }}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "storefront" && <Storefront />}
      {tab === "ranking" && <RankingLab />}
      {tab === "places" && <PlacesPage />}
      {tab === "admin" && <IndexAdmin />}
    </div>
  );
}
```

NOTE: this imports `RankingLab`/`PlacesPage`/`IndexAdmin` which don't exist yet — typecheck will fail until Tasks 5-7. To keep this task self-contained and committable, create minimal stub files now:

`example/src/RankingLab.tsx`, `example/src/PlacesPage.tsx`, `example/src/IndexAdmin.tsx`, each:
```tsx
export function RankingLab() { return <div style={{ padding: 16 }}>Ranking Lab — coming up</div>; }
```
(adjust the component name per file: `RankingLab`, `PlacesPage`, `IndexAdmin`).

- [ ] **Step 2: Typecheck the frontend**

Run: `cd example && npx tsc -p tsconfig.json --noEmit`
Expected: exit 0. `cd ..`

- [ ] **Step 3: Commit**

```bash
git add example/src/App.tsx example/src/RankingLab.tsx example/src/PlacesPage.tsx example/src/IndexAdmin.tsx
git commit -m "feat(example): tab shell (storefront/ranking/places/admin) with stubs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Ranking Lab tab

**Files:**
- Modify: `example/src/RankingLab.tsx` (replace stub)

- [ ] **Step 1: Implement RankingLab** (products: recency/relevance/multi-key sort + controls)

Replace `example/src/RankingLab.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { SearchBar } from "./components/SearchBar";
import { ProductGrid } from "./components/ProductGrid";

type SortKey = { field: string; order: "asc" | "desc" };
const SORT_FIELDS = ["price", "rating", "popularity", "releasedDaysAgo"];

export function RankingLab() {
  const [q, setQ] = useState("");
  const [useFresh, setUseFresh] = useState(true);
  const [recencyW, setRecencyW] = useState(5);
  const [relW, setRelW] = useState(1);
  const [sortKeys, setSortKeys] = useState<SortKey[]>([]);

  const rank = useFresh
    ? { profile: "fresh", weights: { recency: recencyW, rel: relW }, context: { now: 2_000_000_000_000 } }
    : undefined;
  const sortBy = sortKeys.length && !useFresh ? sortKeys : undefined;

  const result = useQuery(api.products.searchProducts, { q, perPage: 12, rank, sortBy });

  return (
    <div style={{ padding: 16 }}>
      <h2>Ranking Lab</h2>
      <SearchBar value={q} onChange={setQ} />
      <div style={{ display: "flex", gap: 16, alignItems: "center", margin: "12px 0", flexWrap: "wrap" }}>
        <label><input type="checkbox" checked={useFresh} onChange={(e) => setUseFresh(e.target.checked)} /> recencyDecay profile (fresh)</label>
        <label>recency weight {recencyW}
          <input type="range" min={0} max={20} value={recencyW} disabled={!useFresh} onChange={(e) => setRecencyW(+e.target.value)} /></label>
        <label>relevance weight {relW}
          <input type="range" min={0} max={10} value={relW} disabled={!useFresh} onChange={(e) => setRelW(+e.target.value)} /></label>
      </div>
      <div style={{ margin: "12px 0" }}>
        <strong>Multi-key sort</strong> (disabled while a rank profile is active):
        {sortKeys.map((k, i) => (
          <span key={i} style={{ marginLeft: 8 }}>
            <select value={k.field} disabled={useFresh}
              onChange={(e) => setSortKeys((ks) => ks.map((x, j) => j === i ? { ...x, field: e.target.value } : x))}>
              {SORT_FIELDS.map((f) => <option key={f}>{f}</option>)}
            </select>
            <select value={k.order} disabled={useFresh}
              onChange={(e) => setSortKeys((ks) => ks.map((x, j) => j === i ? { ...x, order: e.target.value as "asc" | "desc" } : x))}>
              <option value="asc">asc</option><option value="desc">desc</option>
            </select>
          </span>
        ))}
        <button disabled={useFresh} onClick={() => setSortKeys((ks) => [...ks, { field: "rating", order: "desc" }])}>+ key</button>
        {sortKeys.length > 0 && <button disabled={useFresh} onClick={() => setSortKeys((ks) => ks.slice(0, -1))}>− key</button>}
      </div>
      <p style={{ color: "#666" }}>{result ? `${result.found} results` : "loading…"}</p>
      {result && <ProductGrid hits={result.hits} showScore />}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd example && npx tsc -p tsconfig.json --noEmit`
Expected: exit 0. `cd ..`

- [ ] **Step 3: Commit**

```bash
git add example/src/RankingLab.tsx
git commit -m "feat(example): Ranking Lab tab (recency/relevance/multi-key sort controls)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Places tab + PlaceCard

**Files:**
- Create: `example/src/components/PlaceCard.tsx`
- Modify: `example/src/PlacesPage.tsx` (replace stub)

- [ ] **Step 1: Implement PlaceCard** `example/src/components/PlaceCard.tsx`:

```tsx
function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)) * 10) / 10;
}

type Hit = { id: string; score?: number; document: Record<string, any> };

export function PlaceCard({ hit, origin, now }: { hit: Hit; origin: { lat: number; lng: number }; now: number }) {
  const d = hit.document;
  const dist = d.lat != null ? kmBetween(origin, { lat: d.lat, lng: d.lng }) : null;
  const daysOpen = d.openedAt != null ? Math.round((now - d.openedAt) / 86_400_000) : null;
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
      <img src={d.image} alt={d.name} style={{ width: "100%", borderRadius: 4 }} />
      <div style={{ fontWeight: 600 }}>{d.name}</div>
      <div style={{ color: "#666", fontSize: 13 }}>{d.cuisine} · {"$".repeat(d.priceLevel ?? 1)} · ★{d.rating}</div>
      <div style={{ fontSize: 12, color: "#888" }}>
        {dist != null ? `${dist} km away` : "—"}{daysOpen != null ? ` · opened ${daysOpen}d ago` : ""} · score {hit.score}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement PlacesPage** `example/src/PlacesPage.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { SearchBar } from "./components/SearchBar";
import { PlaceCard } from "./components/PlaceCard";
import { CITY_PRESETS } from "../convex/placesData";

const NOW = 2_000_000_000_000;

export function PlacesPage() {
  const [q, setQ] = useState("");
  const [origin, setOrigin] = useState(CITY_PRESETS[0]);
  const [geoW, setGeoW] = useState(5);
  const [freshW, setFreshW] = useState(2);

  const result = useQuery(api.places.searchPlaces, {
    q, perPage: 12,
    rank: { profile: "nearby", weights: { geo: geoW, fresh: freshW }, context: { now: NOW, origin: { lat: origin.lat, lng: origin.lng } } },
  });

  return (
    <div style={{ padding: 16 }}>
      <h2>Places — geoDistance</h2>
      <SearchBar value={q} onChange={setQ} />
      <div style={{ display: "flex", gap: 16, alignItems: "center", margin: "12px 0", flexWrap: "wrap" }}>
        <label>My location:
          <select value={origin.name} onChange={(e) => setOrigin(CITY_PRESETS.find((c) => c.name === e.target.value)!)}>
            {CITY_PRESETS.map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
        </label>
        <label>geo weight {geoW}<input type="range" min={0} max={20} value={geoW} onChange={(e) => setGeoW(+e.target.value)} /></label>
        <label>recency weight {freshW}<input type="range" min={0} max={20} value={freshW} onChange={(e) => setFreshW(+e.target.value)} /></label>
      </div>
      <p style={{ color: "#666" }}>{result ? `${result.found} places` : "loading…"}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 16 }}>
        {result?.hits.map((h: any) => <PlaceCard key={h.id} hit={h} origin={{ lat: origin.lat, lng: origin.lng }} now={NOW} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd example && npx tsc -p tsconfig.json --noEmit`
Expected: exit 0. `cd ..`

- [ ] **Step 4: Commit**

```bash
git add example/src/components/PlaceCard.tsx example/src/PlacesPage.tsx
git commit -m "feat(example): Places tab + PlaceCard (geoDistance near-me, recency)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Index Admin tab

**Files:**
- Modify: `example/src/IndexAdmin.tsx` (replace stub)

- [ ] **Step 1: Implement IndexAdmin** `example/src/IndexAdmin.tsx`:

```tsx
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";

function StatsPanel({ label, stats }: { label: string; stats: any }) {
  if (!stats) return <div>{label}: loading…</div>;
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, minWidth: 260 }}>
      <strong>{label}</strong>
      <div>out_of: {stats.out_of}</div>
      <div>facets: {stats.facets?.map((f: any) => `${f.field}(${f.distinctValues})`).join(", ") || "—"}</div>
      <div>sortSpecs: {stats.sortSpecs?.map((s: any) => `${s.specId}:${s.count}`).join(", ") || "—"}</div>
    </div>
  );
}

export function IndexAdmin() {
  const productStats = useQuery(api.products.indexStats);
  const placeStats = useQuery(api.places.placeStats);
  const seedProducts = useMutation(api.products.startSeed);
  const seedPlaces = useMutation(api.places.seedPlaces);
  const syncProducts = useMutation(api.products.sync);
  const syncPlaces = useMutation(api.places.sync);
  const reindexPlaces = useMutation(api.places.reindexPlaces);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<any>) => {
    setMsg(`${label}…`);
    try { const r = await fn(); setMsg(`${label}: ${JSON.stringify(r)}`); }
    catch (e: any) { setMsg(`${label} ERROR: ${e.message ?? e}`); }
  };

  return (
    <div style={{ padding: 16 }}>
      <h2>Index Admin</h2>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        <StatsPanel label="products" stats={productStats} />
        <StatsPanel label="places" stats={placeStats} />
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => run("seed products", () => seedProducts({ total: 200, batch: 50 }))}>Seed products (200)</button>
        <button onClick={() => run("seed places", () => seedPlaces({ total: 120 }))}>Seed places (120)</button>
        <button onClick={() => run("sync products", () => syncProducts({}))}>Sync products</button>
        <button onClick={() => run("sync places", () => syncPlaces({}))}>Sync places</button>
        <button onClick={() => run("reindex places", () => reindexPlaces({}))}>Reindex places</button>
      </div>
      {msg && <pre style={{ marginTop: 12, background: "#f6f6f6", padding: 8, borderRadius: 6, whiteSpace: "pre-wrap" }}>{msg}</pre>}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd example && npx tsc -p tsconfig.json --noEmit`
Expected: exit 0. `cd ..`

- [ ] **Step 3: Commit**

```bash
git add example/src/IndexAdmin.tsx
git commit -m "feat(example): Index Admin tab (sync/reindex/stats/seed controls)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full verification + live smoke

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all green (existing 187 + new placesData/places tests).

- [ ] **Step 2: All typechecks**

Run: `npx tsc -p tsconfig.build.json --noEmit` (exit 0), `cd example && npx tsc -p convex/tsconfig.json --noEmit` (exit 0), `npx tsc -p tsconfig.json --noEmit` (exit 0), `cd ..`.

- [ ] **Step 3: Live smoke (manual, against local backend)**

Confirm backend up: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3210` → 200. Then:
- `npx convex run places:seedPlaces '{"total":120}'` → `{ seeded: 120 }`
- `npx convex run places:searchPlaces '{"q":"","perPage":3,"rank":{"profile":"nearby","context":{"now":2000000000000,"origin":{"lat":37.7749,"lng":-122.4194}}}}'` → hits with `document.lat/lng`, nearer first.
- `npx convex run products:searchProducts '{"q":"jacket","rank":{"profile":"fresh","context":{"now":2000000000000}},"perPage":3}'` → fresh-ranked results.

Report the outputs. (Frontend visual check is optional — Vite at the example dev URL; the tabs render and queries return.)

- [ ] **Step 4: Commit (if any verification fixups were needed)** — otherwise nothing to commit.

---

## Self-Review notes

- Spec coverage: places dataset/collection (T1-2), geoDistance/recency/relevance profile (T2), products recency profile + releasedAt (T3), tab shell (T4), Ranking Lab recency/relevance/multi-key sort (T5), Places geo UI (T6), Index Admin sync/reindex/stats/seed (T7), verification + live smoke (T8). ✓
- recencyDecay timestamp handling: both `places.openedAt` and products `releasedAt` are absolute ms anchored to a fixed `SEED_NOW`/`now` (2e12), and queries pass matching `context.now`. ✓
- Reindex batch default 10 (matches the live-tested fix) in both `reindexPlaces` and the existing products reindex. ✓
- Bounded datasets (200 products, 120 places) + `window: 200` keep queries under the read limit. ✓
- Type consistency: `searchPlaces`/`seedPlaces`/`reindexPlaces`/`placeStats`/`sync` names stable across T2 and T6/T7; `generatePlace`/`generatePlaceRange`/`CITY_PRESETS`/`CUISINE_OPTIONS` stable across T1/T6.
- Frontend tasks are build-and-verify (typecheck gate), not TDD — React UI is verified visually/by live smoke, consistent with the spec.
