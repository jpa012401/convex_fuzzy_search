import { action, mutation, query, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { components, api } from "./_generated/api";
import { FuzzySearch } from "@elevatech/fuzzy-search";
import { generateRange, DEFAULT_PROFILE, type Profile } from "./dataset";

const search = new FuzzySearch(components.fuzzySearch);
const COLLECTION = "products";

// Filter/facet field declarations shared by the small demo seed and the large
// synthetic dataset. Numeric fields double as rankBy/sortBy signals.
const FILTER_FIELDS = [
  { field: "brand", type: "string" as const },
  { field: "category", type: "string" as const },
  { field: "subcategory", type: "string" as const },
  { field: "inStock", type: "string" as const },
  { field: "price", type: "number" as const },
  { field: "rating", type: "number" as const },
  { field: "popularity", type: "number" as const },
  { field: "views", type: "number" as const },
  { field: "purchases", type: "number" as const },
  { field: "releasedDaysAgo", type: "number" as const },
  { field: "affinity", type: "number" as const },
];
const FACET_FIELDS = ["brand", "category", "subcategory", "inStock"];

async function createProductsCollection(ctx: any) {
  await search.createCollection(ctx, {
    name: COLLECTION,
    searchFields: ["name", "description", "brand", "category"],
    storedFields: "all",
    filterFields: FILTER_FIELDS,
    facetFields: FACET_FIELDS,
  });
}

// --- editable personalization profile --------------------------------------
async function loadProfile(ctx: QueryCtx): Promise<Profile> {
  const row = await ctx.db
    .query("profiles")
    .withIndex("by_key", (q) => q.eq("key", "default"))
    .unique();
  if (!row) return DEFAULT_PROFILE;
  return {
    preferredCategories: row.preferredCategories,
    preferredBrands: row.preferredBrands,
    pastSearchTerms: row.pastSearchTerms,
  };
}

export const getProfile = query({
  args: {},
  handler: async (ctx) => loadProfile(ctx),
});

export const setProfile = mutation({
  args: {
    preferredCategories: v.array(v.string()),
    preferredBrands: v.array(v.string()),
    pastSearchTerms: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("profiles")
      .withIndex("by_key", (q) => q.eq("key", "default"))
      .unique();
    if (row) await ctx.db.patch(row._id, args);
    else await ctx.db.insert("profiles", { key: "default", ...args });
    return { ok: true };
  },
});

// --- small demo seed (6 hand-written products) -----------------------------
const SAMPLE = [
  { id: "1", name: "Aurora Running Shoe", description: "lightweight road running shoe", brand: "Aurora", category: "Shoes", price: 89, popularity: 50, image: "https://picsum.photos/seed/1/300" },
  { id: "2", name: "Aurora Trail Shoe", description: "grippy off-road trail shoe", brand: "Aurora", category: "Shoes", price: 109, popularity: 10, image: "https://picsum.photos/seed/2/300" },
  { id: "3", name: "Nimbus Rain Jacket", description: "waterproof breathable jacket", brand: "Nimbus", category: "Outerwear", price: 149, popularity: 95, image: "https://picsum.photos/seed/3/300" },
  { id: "4", name: "Nimbus Wool Hat", description: "warm merino wool hat", brand: "Nimbus", category: "Accessories", price: 29, popularity: 80, image: "https://picsum.photos/seed/4/300" },
  { id: "5", name: "Vertex Yoga Mat", description: "non slip cushioned yoga mat", brand: "Vertex", category: "Fitness", price: 39, popularity: 30, image: "https://picsum.photos/seed/5/300" },
  { id: "6", name: "Vertex Water Bottle", description: "insulated stainless steel bottle", brand: "Vertex", category: "Fitness", price: 25, popularity: 99, image: "https://picsum.photos/seed/6/300" },
];

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await search.getCollection(ctx, COLLECTION);
    if (existing) await search.deleteCollection(ctx, COLLECTION);
    await createProductsCollection(ctx);
    await search.upsertMany(ctx, {
      collection: COLLECTION,
      docs: SAMPLE.map(({ id, ...rest }) => ({ id, doc: { id, ...rest } })),
    });
    return { seeded: SAMPLE.length };
  },
});

// --- large synthetic dataset (batched, driven by an action) ----------------

// NOTE on resetting at scale: the component's deleteCollection reads every
// index row (postings/terms/trigrams) for the collection in ONE mutation, which
// exceeds Convex's 4096-reads-per-call limit once a few hundred docs are
// indexed. So we avoid deleting a large collection: re-seeding the deterministic
// ids just UPSERTS (replace semantics). We only drop+recreate when the existing
// collection has the wrong config (e.g. the tiny 6-product seed), where the
// delete is cheap. (A scalable batched deleteCollection is a Phase 4 task.)


// Indexes one batch, then schedules the next — a self-chaining background load.
// Each invocation is its own transaction (bounded reads/writes), and they run
// sequentially so there's no write contention on shared term rows. The client
// doesn't wait; Convex reactivity surfaces progress (out_of climbs live).
// Batch kept modest: each product tokenizes to ~30 terms and a replace-upsert
// reads that doc's postings, so larger batches risk the 4096-reads limit.
export const seedChain = mutation({
  args: { start: v.number(), total: v.number(), batch: v.number() },
  handler: async (ctx, { start, total, batch }) => {
    const count = Math.min(batch, total - start);
    const profile = await loadProfile(ctx); // affinity scored against current prefs
    await search.upsertMany(ctx, {
      collection: COLLECTION,
      docs: generateRange(start, count, profile),
    });
    const next = start + count;
    if (next < total) {
      await ctx.scheduler.runAfter(0, api.products.seedChain, { start: next, total, batch });
    }
    return { indexed: count, done: next >= total };
  },
});

// Kicks off a full large-dataset load in the background. Ensures a full-config
// collection exists (without deleting a large one — re-seeding upserts), then
// schedules the chain. Returns immediately.
export const startSeed = mutation({
  args: { total: v.optional(v.number()), batch: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const total = args.total ?? 5000;
    const batch = args.batch ?? 50;
    const c = await search.getCollection(ctx, COLLECTION);
    const hasFullConfig = !!c?.filterFields?.some((f: any) => f.field === "affinity");
    if (!c) {
      await createProductsCollection(ctx);
    } else if (!hasFullConfig) {
      await search.deleteCollection(ctx, COLLECTION); // small wrong-config collection
      await createProductsCollection(ctx);
    }
    await ctx.scheduler.runAfter(0, api.products.seedChain, { start: 0, total, batch });
    return { scheduled: total, batch };
  },
});

// One-time counter backfill driver for collections indexed before the S1
// aggregate counter existed. Self-chains in the background like seedChain.
export const backfillCounter = mutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), batch: v.optional(v.number()) },
  handler: async (ctx, { cursor, batch }) => {
    const r = await search.backfillCounterPage(ctx, {
      collection: COLLECTION,
      cursor: cursor ?? null,
      batch: batch ?? 500,
    });
    if (!r.done) {
      await ctx.scheduler.runAfter(0, api.products.backfillCounter, { cursor: r.cursor, batch });
    }
    return r;
  },
});

// One-time filter-row backfill driver for collections indexed before the S2
// filter index existed. Self-chains in the background like backfillCounter.
export const backfillFilters = mutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), batch: v.optional(v.number()) },
  handler: async (ctx, { cursor, batch }) => {
    // Default batch is modest: each doc clears + re-inserts one row per
    // filterField, so wide filterFields configs (this demo has ~11) would blow
    // the 4096-reads-per-call limit at larger batches.
    const r = await search.backfillFiltersPage(ctx, {
      collection: COLLECTION,
      cursor: cursor ?? null,
      batch: batch ?? 100,
    });
    if (!r.done) {
      await ctx.scheduler.runAfter(0, api.products.backfillFilters, { cursor: r.cursor, batch });
    }
    return r;
  },
});

// One-time facet-count backfill driver for collections indexed before the S3
// facet counters existed. Self-chains in the background like backfillFilters.
// Idempotent: the component clears the collection's facet rows on the first
// page (cursor null), so re-running from the start is safe.
export const backfillFacets = mutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), batch: v.optional(v.number()) },
  handler: async (ctx, { cursor, batch }) => {
    const r = await search.backfillFacetCountsPage(ctx, {
      collection: COLLECTION,
      cursor: cursor ?? null,
      batch: batch ?? 100,
    });
    if (!r.done) {
      await ctx.scheduler.runAfter(0, api.products.backfillFacets, { cursor: r.cursor, batch });
    }
    return r;
  },
});

// --- query wrapper ---------------------------------------------------------
export const searchProducts = query({
  args: {
    q: v.string(),
    page: v.optional(v.number()),
    perPage: v.optional(v.number()),
    filterBy: v.optional(v.string()),
    facetBy: v.optional(v.array(v.string())),
    sortBy: v.optional(
      v.array(
        v.object({
          field: v.string(),
          order: v.union(v.literal("asc"), v.literal("desc")),
        }),
      ),
    ),
    rankBy: v.optional(
      v.object({
        text: v.optional(v.number()),
        fields: v.optional(
          v.array(v.object({ field: v.string(), weight: v.number() })),
        ),
      }),
    ),
  },
  handler: async (ctx, args) =>
    search.search(ctx, { collection: COLLECTION, ...args }),
});

// --- benchmark harness -----------------------------------------------------
// Runs a representative set of queries and reports found + server-side timing,
// exercising every feature against the loaded dataset.
export const benchmark = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ label: string; found: number; ms: number; top?: string }[]> => {
    const cases: { label: string; args: Record<string, unknown> }[] = [
      { label: "plain term", args: { q: "jacket" } },
      { label: "multi-term AND", args: { q: "waterproof jacket" } },
      { label: "prefix (as-you-type)", args: { q: "jack" } },
      { label: "typo tolerance", args: { q: "jackt" } },
      { label: "browse all", args: { q: "" } },
      { label: "numeric range filter", args: { q: "", filterBy: "price:[50..150]" } },
      { label: "boolean+facet", args: { q: "", filterBy: "inStock:true", facetBy: ["category"] } },
      { label: "category facet (browse)", args: { q: "", facetBy: ["brand", "category"] } },
      {
        label: "personalized weighted sort",
        args: { q: "", rankBy: { text: 1, fields: [{ field: "affinity", weight: 5 }, { field: "popularity", weight: 0.01 }] } },
      },
      { label: "multi-key sort (rating desc)", args: { q: "", sortBy: [{ field: "rating", order: "desc" }] } },
      { label: "deep pagination (page 40)", args: { q: "", page: 40, perPage: 20 } },
    ];
    const out = [];
    for (const c of cases) {
      const r: any = await ctx.runQuery(api.products.searchProducts, c.args as any);
      out.push({
        label: c.label,
        found: r.found,
        ms: r.search_time_ms,
        top: r.hits[0]?.document?.name,
      });
    }
    return out;
  },
});
