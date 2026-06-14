import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { FuzzySearch } from "@elevatech/fuzzy-search";

const search = new FuzzySearch(components.fuzzySearch);
const COLLECTION = "products";

// `popularity` is deliberately uncorrelated with price/relevance so the weighted
// blend (rankBy) visibly reorders results when you crank its weight.
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
    await search.createCollection(ctx, {
      name: COLLECTION,
      searchFields: ["name", "description", "brand", "category"],
      storedFields: "all",
      filterFields: [
        { field: "brand", type: "string" },
        { field: "category", type: "string" },
        { field: "price", type: "number" },
      ],
      facetFields: ["brand", "category"],
    });
    await search.upsertMany(ctx, {
      collection: COLLECTION,
      docs: SAMPLE.map(({ id, ...rest }) => ({ id, doc: { id, ...rest } })),
    });
    return { seeded: SAMPLE.length };
  },
});

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
