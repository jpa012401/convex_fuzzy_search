import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
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
});
