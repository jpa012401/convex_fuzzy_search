import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { TypesenseSearch } from "@elevatech/typesense-search";

const search = new TypesenseSearch(components.typesenseSearch);
const COLLECTION = "products";

const SAMPLE = [
  { id: "1", name: "Aurora Running Shoe", description: "lightweight road running shoe", brand: "Aurora", category: "Shoes", price: 89, image: "https://picsum.photos/seed/1/300" },
  { id: "2", name: "Aurora Trail Shoe", description: "grippy off-road trail shoe", brand: "Aurora", category: "Shoes", price: 109, image: "https://picsum.photos/seed/2/300" },
  { id: "3", name: "Nimbus Rain Jacket", description: "waterproof breathable jacket", brand: "Nimbus", category: "Outerwear", price: 149, image: "https://picsum.photos/seed/3/300" },
  { id: "4", name: "Nimbus Wool Hat", description: "warm merino wool hat", brand: "Nimbus", category: "Accessories", price: 29, image: "https://picsum.photos/seed/4/300" },
  { id: "5", name: "Vertex Yoga Mat", description: "non slip cushioned yoga mat", brand: "Vertex", category: "Fitness", price: 39, image: "https://picsum.photos/seed/5/300" },
  { id: "6", name: "Vertex Water Bottle", description: "insulated stainless steel bottle", brand: "Vertex", category: "Fitness", price: 25, image: "https://picsum.photos/seed/6/300" },
];

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await search.getCollection(ctx, COLLECTION);
    if (!existing) {
      await search.createCollection(ctx, {
        name: COLLECTION,
        searchFields: ["name", "description", "brand", "category"],
        storedFields: "all",
      });
    }
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
  },
  handler: async (ctx, args) =>
    search.search(ctx, { collection: COLLECTION, ...args }),
});
