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

  it("maintains facetPostings on upsert and delete", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "fp",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }],
      facetFields: ["brand"],
    });
    await t.mutation(api.write.upsert, { collection: "fp", id: "a", doc: { name: "x", brand: "Acme" } });
    const after = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("facetPostings")
        .withIndex("by_collection_field_value", (q) => q.eq("collection", "fp").eq("field", "brand").eq("value", "Acme"))
        .collect();
      return rows.flatMap((r) => r.docKeys);
    });
    expect(after.length).toBe(1);
    await t.mutation(api.write.delete, { collection: "fp", id: "a" });
    const gone = await t.run(async (ctx) =>
      ctx.db.query("facetPostings").withIndex("by_collection_field_value", (q) => q.eq("collection", "fp").eq("field", "brand").eq("value", "Acme")).collect(),
    );
    expect(gone.length).toBe(0); // emptied bucket deleted
  });

  it("moves a docKey between facet values on a value-change upsert (REPLACE)", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "rp",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }],
      facetFields: ["brand"],
    });
    await t.mutation(api.write.upsert, { collection: "rp", id: "a", doc: { name: "x", brand: "Acme" } });
    // change brand Acme -> Beta via re-upsert of the same id
    await t.mutation(api.write.upsert, { collection: "rp", id: "a", doc: { name: "x", brand: "Beta" } });
    const counts = await t.run(async (ctx) => {
      const dk = async (value: string) => {
        const rows = await ctx.db
          .query("facetPostings")
          .withIndex("by_collection_field_value", (q) => q.eq("collection", "rp").eq("field", "brand").eq("value", value))
          .collect();
        return rows.flatMap((r) => r.docKeys).length;
      };
      return { acme: await dk("Acme"), beta: await dk("Beta") };
    });
    expect(counts.acme).toBe(0); // old value fully dropped (emptied bucket deleted)
    expect(counts.beta).toBe(1); // new value has the docKey
  });
});
