# Full Feature-Demo App — Design

**Date:** 2026-06-15
**Status:** Approved (design); pending implementation plan
**Scope:** Expand the example app into a tabbed, full-feature demonstration of the FuzzySearch component: every search capability (text/fuzzy, queryBy, filter, facet, multi-key sort, all rank-profile term types, pagination, highlighting) and the index lifecycle (config sync, app-driven reindex, hydration, stats). Adds a new geo-located `places` dataset/collection to demonstrate `geoDistance`, and surfaces the lifecycle in an Index Admin tab. Pure example/demo wiring of existing component features — **no new component capabilities**.

## Problem

The example app is a single `Storefront` page that demonstrates a subset of features (text, filter, facet, sort, the `boosted` rank profile, a stats panel). Several component capabilities are not shown anywhere: the `recencyDecay`, `geoDistance`, and `relevance` rank-term types; an explicit multi-key `sortBy` showcase; and the index lifecycle (config `sync`, `pendingFields` → `reindex` → `clearPending`, hydration) that the architecture work added. `geoDistance` in particular can't be shown on the product catalog because products have no coordinates. The goal: a single app where every component feature is visible and interactive.

## Decisions (locked)

1. **Tabbed app, four tabs**, each a coherent feature group with its own Convex query wrappers:
   - **Storefront** — existing page, largely unchanged: text (exact/prefix/typo), `queryBy`, `filterBy` (string/number/range/bool), `facetBy` + counts, multi-key `sortBy`, the `boosted` rank profile, pagination, highlighting. Dataset: existing `products`.
   - **Ranking Lab** — products; interactive `recencyDecay`, `relevance` term, explicit multi-key `sortBy`, live weight/half-life controls, per-query weight overrides.
   - **Places** — new geo `places` collection; `geoDistance` (near-me), `recencyDecay` (newly opened), `relevance`, cuisine facet/filter.
   - **Index Admin** — config `sync`, `pendingFields`/`reindex`/`clearPending`, `stats` (index health) for both collections, seed/reset controls, hydration visibility.
2. **Tab shell is lightweight** — `App.tsx` becomes a `useState<Tab>` switch with a tab bar; no routing library (matches the existing inline-style approach).
3. **Two datasets**: existing `products` (recency via a derived `releasedAt`, relevance, multi-key sort) and a **new** `places` (geoDistance's natural home). Each term type is demonstrated where it is realistic.
4. **App owns serving docs**: `places` gets a `placeDocs` app table mirroring `productDocs`; search returns ids, the app hydrates. Same id-results contract as the rest of the app.
5. **Existing components reused**: `SearchBar`, `FacetSidebar`, `ProductGrid`, `PreferencesEditor`, and the stats panel are reused across tabs where applicable. Storefront tab is the existing page.
6. **v1 location UI** is lat/lng inputs + city preset buttons (no embedded map widget).

### Explicitly out of scope

- No new component features — only example/demo wiring of existing capabilities.
- No embedded map widget (lat/lng inputs + presets suffice for v1).
- No routing library; `useState` tab switching.

## New dataset & collection: `places`

`example/convex/placesData.ts` — deterministic generator (seeded RNG, like `dataset.ts`):

```ts
type Place = {
  id: string;            // "pl00001"
  name: string;
  cuisine: string;       // searchField + filter + facet
  description: string;   // searchField
  lat: number; lng: number;      // geoDistance
  rating: number;        // filter + base sort
  priceLevel: number;    // 1..4, filter + facet
  openedAt: number;      // absolute ms timestamp, recencyDecay
  popularity: number;    // field term
  image: string;
};
```

Coordinates are scattered around a few city centers (deterministic per index) so "near me" is meaningful. `openedAt` is an absolute millisecond timestamp (recencyDecay compares it against `context.now`).

`example/convex/places.ts` (mirrors `products.ts`):

```ts
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
      sortSpecs: [[{ field: "rating", order: "desc" }]],   // base for the geo profile
      rankProfiles: {
        nearby: {
          base: "rating:desc",
          window: 200,
          terms: [
            { id: "geo",  type: "geoDistance",  weight: 5, latField: "lat", lngField: "lng", maxKm: 25 },
            { id: "fresh",type: "recencyDecay", weight: 2, field: "openedAt", halfLifeMs: 7776000000 }, // ~90d
            { id: "rel",  type: "relevance",    weight: 1 },
          ],
        },
      },
    },
  },
});
```

App table (in `example/convex/schema.ts`):
```ts
placeDocs: defineTable({ docId: v.string(), doc: v.any() }).index("by_docId", ["docId"]),
```

Query/mutation wrappers (parallel to products): `seedPlaces`/`startSeedPlaces`/`seedPlacesChain`, `syncPlaces` (`= search.sync(ctx)`), `searchPlaces` (search + hydrate from `placeDocs`), `reindexPlaces` (self-chaining, default batch 10), `placeStats`.

## recencyDecay on products

`recencyDecay` needs an absolute `openedAt`/`releasedAt` timestamp compared to `context.now`. The products dataset stores `releasedDaysAgo` (relative). On seed, add a derived `releasedAt = <seed time> - releasedDaysAgo * 86400000` to each product doc so a recency rank term works without changing the dataset's existing meaning. The Ranking Lab passes `context: { now: Date.now() }`. (Seed-time `now` is fine for a demo; absolute drift over days is immaterial to the demo's intent.)

A `releasedAt` rank profile is added to the `products` collection config (e.g. profile `fresh` with a `recencyDecay` term on `releasedAt` plus a `relevance` term), applied via the existing `sync`. Because adding a rank profile is a **metadata-only** config change (no new structural field), `sync` applies it in place with no reindex.

## Frontend tabs

- **`App.tsx`** — `useState<"storefront"|"ranking"|"places"|"admin">`; renders a tab bar + the active tab. Reuses existing styles.
- **Storefront** — the existing `Storefront.tsx`, rendered as tab 1. Its internals are unchanged; only its placement moves from `App.tsx`'s root render into the tab switch (a one-line wiring change, no logic edits).
- **`RankingLab.tsx`** (products): optional `q` (shows `relevance` blending); per-term toggles + weight sliders (`recencyDecay` with half-life slider, `relevance`, existing `popularity`/`affinity` field terms); a multi-key `sortBy` builder (add/remove keys: field + asc/desc) demonstrating hard multi-key sort distinctly from soft re-rank; live `ProductGrid` results showing each hit's `score`. Sends `rank: { profile, weights, context: { now } }`; weight/half-life controls map to `weights` overrides and `context.now`.
- **`PlacesPage.tsx`** + **`PlaceCard.tsx`** (places): a "my location" control (lat/lng inputs + city preset buttons, default city-center origin so geo is never undefined); toggles for the `nearby` profile terms; optional `q` + cuisine facet/filter; cards show distance-from-me, cuisine, rating, "opened N days ago". Sends `rank: { profile: "nearby", context: { now, origin: { lat, lng } }, weights }`.
- **`IndexAdmin.tsx`**: per-collection seed/reset buttons; "Run sync" showing `{ kind, pendingFields }`; live `pendingFields` display + "Reindex" button driving the self-chaining reindex + `clearPending` status; the `stats` panel (out_of, per-facet totals, per-sortSpec counts) for both collections; surfaces a missing-hydration count if any.

## Data flow

```
tab → Convex query/mutation wrapper → component (search/sync/reindex)
    → app hydrates ids from productDocs / placeDocs → React renders
```
Same id-results + hydration contract everywhere (already proven live).

## Error handling

- **Bounded datasets** (~200 products, ~150 places) and `window: 200` on rank profiles keep every query under the 4,096-reads-per-call limit (the unselective-filter read-limit class observed in live testing does not arise at this size).
- **Reindex** uses the self-chaining mutation (default batch 10, already fixed) — cannot exceed the read limit.
- **Missing hydration**: wrappers use `?? {}`; cards render gracefully; Index Admin surfaces a count.
- **Component validation errors** (unknown filter field, etc.) propagate to a visible error banner per tab rather than crashing.
- **geoDistance without origin**: the `nearby` geo term contributes 0 when `context.origin` is absent; Places always supplies a default origin.

## Testing

- **`places.test.ts`** (component-style, convexTest + `registerAggregate` for `docCount` and `sortIndex`): seed places → `searchPlaces` with a geo `context.origin` returns nearer places first; recencyDecay orders newer `openedAt` first; multi-key sort orders correctly; cuisine facet/filter returns the right set.
- **Dataset determinism**: `generatePlace(i)` is stable across runs (seeded RNG), mirroring the products dataset's determinism guarantee.
- **No new component tests** — `recencyDecay`/`geoDistance`/`relevance` already have component-level coverage; this work is example/integration.
- **Live smoke** (manual, post-implementation): seed places, query "near me" from a city preset, confirm distance ordering and recency; run the Index Admin sync/reindex flow against the live local backend.

## Suggested phasing (for the implementation plan)

1. **places dataset + collection + backend wrappers** (`placesData.ts`, `places.ts`, schema `placeDocs`) + `places.test.ts`. Independent, testable headless.
2. **Products recency profile** (`releasedAt` derived field on seed + `fresh` rank profile via sync).
3. **Tab shell** (`App.tsx`) + move Storefront into tab 1.
4. **Ranking Lab** tab (products: recency/relevance/multi-key sort/weight controls).
5. **Places** tab (geoDistance UI + hydration + PlaceCard).
6. **Index Admin** tab (sync/reindex/stats/seed controls).
