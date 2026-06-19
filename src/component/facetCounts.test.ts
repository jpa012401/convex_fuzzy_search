import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  incrementFacet,
  decrementFacet,
  readFacetCounts,
  clearCollectionFacets,
} from "./facetCounts";

const modules = import.meta.glob("./**/*.ts");

describe("facetCounts helpers", () => {
  it("increment creates then bumps a row", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await incrementFacet(ctx, "shop", "brand", "Aurora");
      await incrementFacet(ctx, "shop", "brand", "Aurora");
      const counts = await readFacetCounts(ctx, "shop", "brand", 10);
      expect(counts).toEqual([{ value: "Aurora", count: 2 }]);
    });
  });

  it("decrement lowers, and deletes the row at zero", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await incrementFacet(ctx, "shop", "brand", "Aurora");
      await decrementFacet(ctx, "shop", "brand", "Aurora");
      expect(await readFacetCounts(ctx, "shop", "brand", 10)).toEqual([]);
      // decrement on a missing row is a safe no-op
      await decrementFacet(ctx, "shop", "brand", "Aurora");
      expect(await readFacetCounts(ctx, "shop", "brand", 10)).toEqual([]);
    });
  });

  it("readFacetCounts sorts count desc then value asc, and respects maxValues", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await incrementFacet(ctx, "shop", "brand", "Beta"); // 1
      await incrementFacet(ctx, "shop", "brand", "Aurora");
      await incrementFacet(ctx, "shop", "brand", "Aurora"); // 2
      await incrementFacet(ctx, "shop", "brand", "Cobalt");
      await incrementFacet(ctx, "shop", "brand", "Cobalt"); // 2 (ties Aurora -> value asc)
      const top2 = await readFacetCounts(ctx, "shop", "brand", 2);
      expect(top2).toEqual([
        { value: "Aurora", count: 2 },
        { value: "Cobalt", count: 2 },
      ]);
    });
  });

  it("isolates fields and collections", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await incrementFacet(ctx, "shop", "brand", "Aurora");
      await incrementFacet(ctx, "shop", "category", "Aurora");
      await incrementFacet(ctx, "other", "brand", "Aurora");
      expect(await readFacetCounts(ctx, "shop", "brand", 10)).toEqual([{ value: "Aurora", count: 1 }]);
      await clearCollectionFacets(ctx, "shop");
      expect(await readFacetCounts(ctx, "shop", "brand", 10)).toEqual([]);
      expect(await readFacetCounts(ctx, "shop", "category", 10)).toEqual([]);
      // other collection untouched
      expect(await readFacetCounts(ctx, "other", "brand", 10)).toEqual([{ value: "Aurora", count: 1 }]);
    });
  });

  it("stats reports high-cardinality facet truncation", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "shop",
      searchFields: ["name"],
      facetFields: ["brand"],
    });
    await t.run(async (ctx) => {
      for (let i = 0; i < 210; i++) {
        await ctx.db.insert("facetCounts", {
          collection: "shop",
          field: "brand",
          value: `brand-${i}`,
          count: 1,
        });
      }
    });
    const stats = await t.query(api.stats.stats, { collection: "shop" });
    expect(stats.facets[0]).toMatchObject({
      field: "brand",
      distinctValues: 200,
      total: 200,
      truncated: true,
    });
  });

  it("stats reports filterPostings health for string and numeric filter fields", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "items",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [
        { field: "brand", type: "string" as const },
        { field: "price", type: "number" as const },
      ],
    });
    await t.mutation(api.write.upsert, {
      collection: "items",
      id: "i1",
      doc: { name: "Widget A", brand: "Acme", price: 10 },
    });
    await t.mutation(api.write.upsert, {
      collection: "items",
      id: "i2",
      doc: { name: "Widget B", brand: "Beta", price: 20 },
    });
    const stats = await t.query(api.stats.stats, { collection: "items" });
    const brandEntry = stats.filterPostings.find((e) => e.field === "brand");
    const priceEntry = stats.filterPostings.find((e) => e.field === "price");
    expect(brandEntry).toBeDefined();
    expect(brandEntry?.totalDocKeys).toBe(2);
    expect(priceEntry).toBeDefined();
    expect(priceEntry?.totalDocKeys).toBe(2);
  });
});
