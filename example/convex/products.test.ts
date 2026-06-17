import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import { register as registerFuzzySearch } from "@elevatech/fuzzy-search/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

function registerExample(t: ReturnType<typeof convexTest>) {
  registerFuzzySearch(t);
  registerAggregate(t, "fuzzySearch/docCount");
  registerAggregate(t, "fuzzySearch/sortIndex");
}

describe("products lifecycle", () => {
  it("sync, seed, search, update, delete, and drop collection with convex ids", async () => {
    const t = convexTest(schema, modules);
    registerExample(t);

    await t.mutation(api.products.sync, {});
    await t.mutation(api.products.seed, {});

    const statsAfterSeed = await t.query(api.products.indexStats, {});
    expect(statsAfterSeed.out_of).toBe(6);

    const initial = await t.query(api.products.searchProducts, { q: "Aurora", perPage: 10 });
    expect(initial.found).toBeGreaterThan(0);
    const hitId = initial.hits[0]!.id;
    expect(hitId).not.toMatch(/^p\d{5}$/);
    expect(hitId).not.toMatch(/^[0-9]+$/);

    const stored = await t.run(async (ctx) => {
      const row = await ctx.db.get("productDocs", hitId as any);
      return row?.doc as Record<string, unknown>;
    });
    await t.mutation(api.products.updateProduct, {
      id: hitId as any,
      doc: {
        ...stored,
        name: "Zephyr Winter Boot",
        description: "warm insulated boot",
        brand: "Zephyr",
      },
    });

    const afterUpdateOld = await t.query(api.products.searchProducts, { q: "Aurora", perPage: 10 });
    const afterUpdateNew = await t.query(api.products.searchProducts, { q: "Zephyr", perPage: 10 });
    expect(afterUpdateOld.hits.some((h) => h.id === hitId)).toBe(false);
    expect(afterUpdateNew.hits.some((h) => h.id === hitId)).toBe(true);

    await t.mutation(api.products.deleteProduct, { id: hitId as any });
    const afterDelete = await t.query(api.products.searchProducts, { q: "Zephyr", perPage: 10 });
    expect(afterDelete.hits.some((h) => h.id === hitId)).toBe(false);

    const statsAfterDelete = await t.query(api.products.indexStats, {});
    expect(statsAfterDelete.out_of).toBe(5);

    await t.mutation(api.products.dropProducts, {});
    const remainingDocs = await t.run(async (ctx) => await ctx.db.query("productDocs").collect());
    expect(remainingDocs).toEqual([]);
    await expect(t.query(api.products.indexStats, {})).rejects.toThrow(/CollectionNotFound/);
  });

  it("background seed inserts convex ids for each productDoc row", async () => {
    const t = convexTest(schema, modules);
    registerExample(t);

    await t.mutation(api.products.sync, {});
    await t.mutation(api.products.seedChain, { start: 0, total: 12, batch: 12 });

    const stats = await t.query(api.products.indexStats, {});
    expect(stats.out_of).toBe(12);

    const browse = await t.query(api.products.searchProducts, { q: "", perPage: 5 });
    expect(browse.found).toBe(12);
    for (const hit of browse.hits) {
      expect(hit.id).not.toMatch(/^p\d{5}$/);
    }

    const appRows = await t.run(async (ctx) => await ctx.db.query("productDocs").collect());
    expect(appRows).toHaveLength(12);
    expect(new Set(appRows.map((row) => row._id)).size).toBe(12);
  });
});
