import { action, mutation, query, QueryCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { components, api } from "./_generated/api";
import { FuzzySearch } from "@elevatech/fuzzy-search";
import { generateRange, DEFAULT_PROFILE, type Profile } from "./dataset";

const COLLECTION = "products";
const MAX_COMPONENT_BATCH = 50;

// recencyDecay needs an absolute ms timestamp; the dataset stores the relative
// releasedDaysAgo. Derive releasedAt from the real current time at seed so the
// 'fresh' profile ranks meaningfully (a fixed future anchor would make every
// releasedAt future-dated and recencyDecay inert).
function withReleasedAt(doc: Record<string, unknown>, now: number): Record<string, unknown> {
  const daysAgo = typeof doc.releasedDaysAgo === "number" ? doc.releasedDaysAgo : 0;
  return { ...doc, releasedAt: now - daysAgo * 86_400_000 };
}

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

// Sort orders we index for scalable unfiltered browse-by-sort (must match the
// sortBy the UI sends). Each is a declared composite spec.
export const SORT_SPECS = [
  [{ field: "price", order: "asc" as const }],
  [{ field: "price", order: "desc" as const }],
  [{ field: "popularity", order: "desc" as const }],
];

// A rank profile for the storefront: boost popularity + affinity + preferred
// categories, re-ranking a window taken off the popularity base order.
export const RANK_PROFILES = {
  boosted: {
    base: "popularity:desc",
    window: 200,
    terms: [
      { id: "pop", type: "field" as const, weight: 0.001, field: "popularity" },
      { id: "aff", type: "field" as const, weight: 1, field: "affinity" },
      { id: "pref", type: "setBoost" as const, weight: 5, field: "category", setKey: "prefCats" },
    ],
  },
  fresh: {
    base: "popularity:desc",
    window: 200,
    terms: [
      { id: "recency", type: "recencyDecay" as const, weight: 5, field: "releasedAt", halfLifeMs: 7_776_000_000 },
      { id: "rel", type: "relevance" as const, weight: 1 },
      { id: "pop", type: "field" as const, weight: 0.001, field: "popularity" },
    ],
  },
};

const search = new FuzzySearch(components.fuzzySearch, {
  collections: {
    products: {
      searchFields: ["name", "description", "brand", "category"],
      // app hydrates serving fields from productDocs; component stores only the index-relevant projection
      storedFields: "derived",
      filterFields: FILTER_FIELDS,
      facetFields: FACET_FIELDS,
      sortSpecs: SORT_SPECS,
      rankProfiles: RANK_PROFILES,
    },
  },
});

export const sync = mutation({
  args: {},
  handler: async (ctx) => search.sync(ctx),
});

// The app owns the serving copy: write each doc to productDocs alongside the
// component upsert, so search results can be hydrated by id afterwards.
async function putDocs(ctx: MutationCtx, docs: { id: string; doc: Record<string, unknown> }[]) {
  for (const { id, doc } of docs) {
    const existing = await ctx.db.query("productDocs").withIndex("by_docId", (q) => q.eq("docId", id)).unique();
    if (existing) await ctx.db.patch(existing._id, { doc });
    else await ctx.db.insert("productDocs", { docId: id, doc });
  }
}

// Joins the component's id-only hits back to the app's serving docs, preserving
// the returned order. Adds a `document` field shaped like what ProductGrid renders.
async function hydrate(ctx: QueryCtx, hits: { id: string; score: number; highlight: any }[]) {
  const rows = await Promise.all(
    hits.map((h) => ctx.db.query("productDocs").withIndex("by_docId", (q) => q.eq("docId", h.id)).unique()),
  );
  return hits.map((h, i) => ({ ...h, document: (rows[i]?.doc ?? {}) as Record<string, unknown> }));
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
    await search.sync(ctx);
    const now = Date.now();
    const docs = SAMPLE.map(({ id, ...rest }) => ({ id, doc: withReleasedAt({ id, ...rest }, now) }));
    await search.upsertMany(ctx, { collection: COLLECTION, docs });
    await putDocs(ctx, docs);
    return { seeded: SAMPLE.length };
  },
});

// --- large synthetic dataset (batched, driven by an action) ----------------

// NOTE on resetting at scale: the component's deleteCollection reads every
// index row (postings/terms/trigrams) for the collection in ONE mutation, which
// exceeds Convex's 4096-reads-per-call limit once a few hundred docs are
// indexed. So we never delete a large collection: re-seeding the deterministic
// ids just UPSERTS (replace semantics), and sync() reconciles config in place.
// Only the small `seed` mutation does an explicit drop+sync for a clean reset,
// where the delete is cheap at 6 docs. (A scalable batched deleteCollection is
// a Phase 4 task.)


// Indexes one batch, then schedules the next — a self-chaining background load.
// Each invocation is its own transaction (bounded reads/writes), and they run
// sequentially so there's no write contention on shared term rows. The client
// doesn't wait; Convex reactivity surfaces progress (out_of climbs live).
// Batch kept modest: each product tokenizes to ~30 terms and a replace-upsert
// reads that doc's postings, so larger batches risk the 4096-reads limit.
export const seedChain = mutation({
  args: { start: v.number(), total: v.number(), batch: v.number() },
  handler: async (ctx, { start, total, batch }) => {
    const count = Math.min(batch, MAX_COMPONENT_BATCH, total - start);
    const profile = await loadProfile(ctx); // affinity scored against current prefs
    const now = Date.now();
    const docs = generateRange(start, count, profile);
    const docs2 = docs.map((d) => ({ id: d.id, doc: withReleasedAt(d.doc, now) }));
    await search.upsertMany(ctx, { collection: COLLECTION, docs: docs2 });
    await putDocs(ctx, docs2);
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
    const batch = Math.min(args.batch ?? MAX_COMPONENT_BATCH, MAX_COMPONENT_BATCH);
    // sync() is idempotent: it creates the collection if missing and reconciles
    // config in place otherwise. We never drop+recreate a large collection here —
    // deleteCollection reads every index row in one mutation and would exceed
    // Convex's 4096-reads-per-call limit once a few hundred docs are indexed
    // (re-seeding the deterministic ids just upserts with replace semantics).
    await search.sync(ctx);
    await ctx.scheduler.runAfter(0, api.products.seedChain, { start: 0, total, batch });
    return { scheduled: total, batch };
  },
});

// Replays the app-owned productDocs back through the component's upsert,
// rebuilding index rows for any newly-added structural field, then clears the
// collection's pending flag when done. Self-chains in the background like
// seedChain. The PAGE SOURCE is the app's own table — the component no longer
// holds the full serving doc, so the app drives the replay.
export const reindex = mutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), batch: v.optional(v.number()) },
  handler: async (ctx, { cursor, batch }) => {
    // Small default batch: each replayed upsert does a clear-then-rebuild that
    // READS the doc's whole index footprint (postings/terms/trigrams/filters),
    // so the per-doc read cost is far higher than a fresh insert. Batches above
    // ~10-20 risk the 4,096-reads-per-call limit on docs with many terms.
    const size = Math.min(batch ?? 10, MAX_COMPONENT_BATCH);
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

// Index-health snapshot for the validation panel in the storefront.
export const indexStats = query({
  args: {},
  handler: async (ctx) => search.stats(ctx, COLLECTION),
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
    rank: v.optional(
      v.object({
        profile: v.string(),
        weights: v.optional(v.record(v.string(), v.number())),
        context: v.optional(
          v.object({
            now: v.optional(v.number()),
            origin: v.optional(v.object({ lat: v.number(), lng: v.number() })),
            sets: v.optional(v.record(v.string(), v.array(v.string()))),
          }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const r = await search.search(ctx, { collection: COLLECTION, ...args });
    return { ...r, hits: await hydrate(ctx, r.hits) };
  },
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
      const start = Date.now();
      const r: any = await ctx.runQuery(api.products.searchProducts, c.args as any);
      out.push({
        label: c.label,
        found: r.found,
        ms: Date.now() - start,
        top: r.hits[0]?.document?.name,
      });
    }
    return out;
  },
});
