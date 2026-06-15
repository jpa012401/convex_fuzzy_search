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

export const seedPlaces = mutation({
  args: { total: v.optional(v.number()) },
  handler: async (ctx, { total }) => {
    await search.sync(ctx);
    const n = total ?? 120;
    const now = Date.now();
    const docs = generatePlaceRange(0, n, now);
    await search.upsertMany(ctx, { collection: COLLECTION, docs });
    await putDocs(ctx, docs);
    return { seeded: n, now };
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
