import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { readFacetCounts } from "./facetCounts";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
    facetFields: ["brand", "category"],
  });
  return t;
}

const brandCounts = (t: any) =>
  t.run((ctx: any) => readFacetCounts(ctx, "shop", "brand", 10));

describe("write path maintains facet counts", () => {
  it("upsert increments each declared facet value", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "shoe", brand: "Aurora", category: "Footwear" } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "p2", doc: { name: "boot", brand: "Aurora", category: "Footwear" } });
    expect(await brandCounts(t)).toEqual([{ value: "Aurora", count: 2 }]);
  });

  it("replace with a changed value moves the count (no orphan, no double count)", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Aurora", category: "A" } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Nimbus", category: "A" } });
    expect(await brandCounts(t)).toEqual([{ value: "Nimbus", count: 1 }]);
  });

  it("replace with an unchanged value keeps the count correct", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Aurora", category: "A" } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "y", brand: "Aurora", category: "A" } });
    expect(await brandCounts(t)).toEqual([{ value: "Aurora", count: 1 }]);
  });

  it("missing/null facet value contributes no row", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", category: "A" } });
    expect(await brandCounts(t)).toEqual([]);
  });

  it("delete decrements", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Aurora", category: "A" } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "p2", doc: { name: "y", brand: "Aurora", category: "A" } });
    await t.mutation(api.write.delete, { collection: "shop", id: "p1" });
    expect(await brandCounts(t)).toEqual([{ value: "Aurora", count: 1 }]);
  });

  it("deleteCollection clears facet counts", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Aurora", category: "A" } });
    await t.mutation(api.collections.deleteCollection, { name: "shop" });
    // Recreate so readFacetCounts has a valid (empty) namespace to read.
    await t.mutation(api.collections.createCollection, { name: "shop", searchFields: ["name"], storedFields: "all", facetFields: ["brand"] });
    expect(await brandCounts(t)).toEqual([]);
  });

  it("backfill rebuilds facet counts for pre-existing docs", async () => {
    const t = await setup();
    // Insert document rows directly, bypassing the write path (simulates pre-S3 docs).
    await t.run(async (ctx) => {
      await ctx.db.insert("documents", { collection: "shop", docId: "z1", stored: { name: "a", brand: "Aurora", category: "A" } });
      await ctx.db.insert("documents", { collection: "shop", docId: "z2", stored: { name: "b", brand: "Aurora", category: "B" } });
    });
    expect(await brandCounts(t)).toEqual([]);
    let cursor: string | null = null;
    do {
      const r: any = await t.mutation(api.backfill.backfillFacetCountsPage, { collection: "shop", cursor, batch: 1 });
      cursor = r.cursor;
    } while (cursor !== null);
    expect(await brandCounts(t)).toEqual([{ value: "Aurora", count: 2 }]);
  });

  it("backfill is idempotent (clears then rebuilds; re-run yields same counts)", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Aurora", category: "A" } });
    let cursor: string | null = null;
    do {
      const r: any = await t.mutation(api.backfill.backfillFacetCountsPage, { collection: "shop", cursor, batch: 5 });
      cursor = r.cursor;
    } while (cursor !== null);
    expect(await brandCounts(t)).toEqual([{ value: "Aurora", count: 1 }]);
    cursor = null;
    do {
      const r: any = await t.mutation(api.backfill.backfillFacetCountsPage, { collection: "shop", cursor, batch: 5 });
      cursor = r.cursor;
    } while (cursor !== null);
    expect(await brandCounts(t)).toEqual([{ value: "Aurora", count: 1 }]);
  });
});
