# Config-Driven Collection Setup + ID-Only Search Results — Design

**Date:** 2026-06-15
**Status:** Approved (design); pending implementation plan
**Scope:** Two related changes to the component's setup and serving model:
(1) replace the imperative `createCollection` mutation as the *primary* setup path with a **declarative config object in app code** that the client **auto-applies** (syncs) — metadata changes are free, structural additions trigger an app-driven reindex;
(2) the component stores only **index-relevant fields** (not full serving documents) and `search` returns **`{ id, score }` + facet counts**, leaving the app to **hydrate** hit contents from its own tables.

## Problem

Today a collection is created by calling `createCollection` by hand (dashboard, script, or one-off mutation). The caller must remember to run it and must hand-author any change. The user wants setup to *feel* like the aggregate component — declared once in code, with changes auto-applying on deploy rather than being described imperatively.

Separately, the component currently stores a full document snapshot (`documents.stored`) and `search` returns that snapshot as hit contents. The user wants the **app** to own and serve documents (it is the system of record), with the component holding only what it needs to index, filter, sort, and re-rank. Search should return **IDs**, and the app should join those IDs against its own tables for contents.

## Decisions (locked)

1. **Setup is a config object in app code**, passed to the `FuzzySearch` client. It is the source of truth for each collection's *field roles* (search / filter / facet / sort / rank). The stored `collections` row becomes **derived state** — a cache the sync reconciles to match code. Code wins.
2. **Auto-apply via an explicit `sync`.** Convex components cannot run code on deploy by themselves, so the app wires **one** `internalMutation` that calls `client.sync(ctx)` (run post-deploy / on app init). After that one-time wiring, every config edit auto-applies. No lazy hot-path sync.
3. **Cost tiers of a config change** (fixed by *change type*, not by the sync mechanism):
   - **Metadata-only** (rankProfiles, weights, `window`, searchField list) → overwrite the row. **O(1), instant.**
   - **Structural addition** (new filterField / facetField / sortSpec) → overwrite the row, then **flag the field "pending"** and require an **app-driven reindex** (see Decision 6). **O(docs)**, paged by the app.
   - **Removal** → overwrite the row; leave dead index rows in place (**lazy cleanup**, harmless, O(1)). Eager cleanup is opt-in.
4. **Component stores index-relevant fields only.** The per-doc snapshot holds the union of fields referenced by any role (search/filter/facet/sort/rank) — **not** large unindexed serving blobs (e.g. `description_html`). Enough to index, filter, sort, and re-rank internally; not enough (nor intended) to serve.
5. **Search returns IDs, app hydrates.** `search.search` returns `{ hits: { id, score }[], found, facetCounts, ... }` — **no document contents**. The app maps the returned IDs to full documents via point lookups against its own tables, **preserving the component's returned order**. Re-rank stays **inside** the component (it has the index-relevant fields, so recency/geo/setBoost/flag all work).
6. **Writes are explicit and app-driven — same as aggregate.** The component exposes verbs (`upsert`, `upsertMany`, `delete`); the app calls them from its own mutations at the point it knows a (possibly normalized) document is complete. The component has **no** reactive triggers and **no** awareness of the app's table topology. Assembling normalized data from multiple app tables into one flat doc is the **app's** responsibility. Bulk load, drift repair, and structural reindex all use this same explicit `upsert` path, paged by the app.

### Explicitly rejected

- **Named instances in `convex.config.ts`** (`app.use(fuzzySearch, { name })` per collection): multiplies every internal table + both internal aggregate instances per collection, and cannot carry structured config (`rankProfiles`, `filterFields`) — component options are static primitives only. Rejected as heavyweight and a poor fit.
- **Lazy auto-sync on first use:** taxes every `search`/`upsert` with a config-hash check and inlines the heavy reindex onto an unlucky live request. Rejected in favor of explicit `sync`.
- **Reactive database triggers (convex-helpers) for auto-upsert:** clean for 1:1 row→doc, but breaks down for documents **normalized across multiple tables** (a related-table change — e.g. a brand rename — fans out to re-index many parent docs; reverse-propagation logic leaks the app's topology into the sync layer). Also bypassed by dashboard edits / `npx convex import`, causing silent index drift. Rejected: writes stay explicit, app-driven, mirroring aggregate.

## Configuration: the collection config object

Declared in app code and handed to the client. One object, N collections, all sharing the component's tables (partitioned by `collection`).

```ts
// app/convex/search.ts
export const search = new FuzzySearch(components.fuzzySearch, {
  collections: {
    products: {
      searchFields: ["title", "description"],
      filterFields: [{ field: "brand", type: "string" }],
      facetFields: ["brand"],
      sortSpecs: [[{ field: "price", order: "asc" }]],
      rankProfiles: { boosted: { base: "price:asc", terms: [/* ... */] } },
    },
  },
});
```

The **union of fields across all roles** = exactly what the app must pass on `upsert` and what the component persists per doc. `storedFields` is no longer hand-specified: it is **derived** from the field roles (= the index-relevant union). Large serving-only fields are simply never sent.

## Sync algorithm (`client.sync(ctx)`)

For each collection in the config, compare the code config against the stored `collections` row and reconcile field-by-field:

| Config field changed | Classification | Action |
| --- | --- | --- |
| `searchFields` weights / list | metadata | overwrite row |
| `rankProfiles`, `window`, weights | metadata | overwrite row |
| `sortSpecs` *ordering* tweak (no new spec) | metadata | overwrite row |
| `+ filterField` | structural add | overwrite row; mark field **pending**; reindex required |
| `+ facetField` | structural add | overwrite row; mark field **pending**; reindex required |
| `+ sortSpec` | structural add | overwrite row; mark field **pending**; reindex required |
| `- field` (any role) | removal | overwrite row; leave dead rows (lazy) |
| collection absent in row | create | insert row (today's `createCollection` validation runs) |
| collection absent in config | (out of scope v1) | leave as-is; do **not** auto-delete |

- **Sync itself is O(1) per collection:** one row write per changed collection plus, for structural additions, recording which fields are pending. It never iterates documents.
- All existing `createCollection` **validation** (storedFields/role consistency, rankProfile base must be a declared sortSpec, duplicate term ids, recencyDecay/geoDistance bounds) runs at sync time against the assembled row.
- `createCollection` / `deleteCollection` mutations **remain** for programmatic/dynamic use; the config path is the recommended one.

## Reindex (app-driven replay)

When sync marks a structural field **pending**, existing component docs lack that field's index rows. Because the component stores only index-relevant fields and the **app is the system of record**, the reindex is driven by the app re-feeding documents:

- The client exposes a reindex helper the app drives with a **source iterator** over its own table (paginated), re-`upsert`ing each doc. The existing paged-backfill loop pattern (`scheduler.runAfter(0, ...)` with a cursor) applies, but the page **source is the app's table**, not the component snapshot.
- The component re-derives the new field's index rows from the re-upserted docs (the existing write path already builds filters/facets/sort from the doc).
- **Partial-results window:** until the reindex completes, the new field is partially indexed — filtering/faceting/sorting on it returns *incomplete* (not erroneous) results. v1 accepts this window; a "field not live until backfilled" gate is out of scope.

## Search result shape

`search.search` returns:

```ts
{
  hits: { id: string; score: number }[];   // was: full doc contents
  found: number;
  out_of: number;
  page: number;
  facetCounts?: { field: string; counts: { value: string; count: number }[] }[];
}
```

- Text matching, `filterBy`, `facetBy`, `sortBy`, and **windowed re-rank** all run inside the component as today, against the index-relevant fields — unchanged logic, the only difference is what is *returned*.
- **App hydration contract:** the app takes `hits.map(h => h.id)`, point-looks-up each in its own table, and **must preserve `hits` order** (do not let the join re-sort). Hydration is **O(perPage)**, indexed — not O(total docs).

## Architecture / data flow

```
                 ┌─────────────────────────── app ───────────────────────────┐
config object ──▶│ client.sync(ctx)  (one internalMutation, post-deploy)      │
                 │ app mutation ──▶ assemble flat doc ──▶ search.upsert(...)   │
                 │ search.search(...) ──▶ [{id,score}] ──▶ hydrate from own tbl│
                 └───────────────────────────┬───────────────────────────────┘
                                              │ (explicit calls, like aggregate)
                 ┌────────────────────────────▼──────────────── component ────┐
                 │ collections row (derived from config; validated)           │
                 │ index-relevant snapshot per doc (NOT serving blobs)        │
                 │ postings/terms/trigrams · filters · facetCounts · sortIndex│
                 │ search: match→filter→facet→sort→windowed re-rank → {id,score}│
                 └────────────────────────────────────────────────────────────┘
```

## Multiple collections

Many collections coexist in the component (shared tables, partitioned by `collection`). **Each `search` call targets exactly one collection** (`collection: v.string()`); the app searches different collections by calling `search` separately, per collection, whenever it needs each — they are independent queries with independent result lists.

This is the only multi-collection requirement: *search collection A, and separately search collection B* — not blend them into one ranked list. It works unchanged under this design; `search` returning `{ id, score }` simply means the app hydrates each call's ids against that collection's backing table.

**Explicitly out of scope:** blended/federated search that merges several collections into one ranked list. Relevance (IDF) is per-collection, so scores are not comparable across collections; combining them would require an app-side merge/normalization policy. Not needed here — the requirement is one collection per call. (If a blended view is ever wanted, it stays an app-side fan-out + merge, never an engine feature; and multiple component instances would not help, since a query still hits one index at a time.)

## Cost & scaling

| Operation | Cost | Notes |
| --- | --- | --- |
| `sync` config row (metadata change) | **O(1)**, 1 write/collection | ranking/weights/removals — the common case |
| `sync` structural add | **O(1)** to flag pending | reindex deferred to app replay |
| Reindex (app replay) | **O(docs × added-field-count)** | paged by app; filter backfill = pure row writes; facet/sort hit the aggregate component (write-throughput bound) |
| `upsert` per doc | postings + filters + facets + sort + store index-relevant fields | smaller snapshot write than today (no serving blobs) |
| `search` | unchanged engine + **smaller payload** (`{id,score}` not contents) | |
| Hydration (app) | **O(perPage)** point lookups | indexed; must preserve order |

The only genuinely heavy operation remains **reindexing existing documents when a structural field is added**, and it is now explicitly the **app's** O(docs) replay — consistent with the app being the system of record.

## Error handling

- **Sync validation failure** (e.g. rankProfile base not a declared sortSpec): sync throws with the same messages as `createCollection` today; no partial row write for that collection.
- **Drift / dashboard imports:** because writes are explicit, bulk imports or dashboard edits to app tables do **not** reach the component. The app must replay affected docs through `upsert` (same path as reindex). This is a documented operational responsibility, not an automatic guarantee.
- **Hydration miss:** an `id` returned by search but absent from the app table (deleted in the app after indexing, before its `delete` reached the component) → the app drops it from the page. Because writes are explicit and may lag, the component's index can briefly name ids the app no longer serves; the app tolerates a missing hydration rather than erroring.

## Testing

- **Sync reconciler:** metadata-only change → 1 row write, 0 doc reads; structural add → row updated + field flagged pending; removal → row updated, dead rows untouched; validation errors surface identically to `createCollection`.
- **Result shape:** `search` returns `{id, score}` + facets, no contents; order preserved through a representative app-side hydration helper in the example app.
- **Index-relevant projection:** a serving-only field present in app docs but in no role is **not** persisted in the component snapshot; a ranking field IS persisted and re-rank reads it.
- **Reindex replay:** add a filterField, run the app-driven replay over a seeded app table, assert filtering returns complete results only after replay completes (and partial during).
- **Example app:** end-to-end — config object → sync → explicit upsert from an app mutation → search → hydrate.

## Scope boundaries (v1)

- No auto-delete of collections absent from config (reconcile additions/edits only).
- No "field not live until backfilled" gate; partial-results window during reindex is accepted.
- No reactive triggers; writes stay explicit.
- Eager removal cleanup is opt-in, not default.
- Each `search` call targets one collection; searching different collections = separate calls. No blended/federated multi-collection search in the engine.

## Suggested phasing (for the implementation plan)

1. **Search returns `{id, score}`** + app hydration (example app updated). Independent, highest-leverage.
2. **Index-relevant projection** (snapshot holds role-union, not serving blobs; `storedFields` derived).
3. **Config object + `sync`** reconciler (metadata + structural-flagging + validation).
4. **App-driven reindex replay** helper + docs for drift/bulk-load.
