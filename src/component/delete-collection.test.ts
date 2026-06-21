import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

// DELETE_BATCH_SIZE=25, DELETE_BATCHES_PER_PUBLIC_CALL=64 -> one public call
// clears up to 25*64=1600 rows. Seed > one batch (60) so we exercise the loop,
// and assert the searchDocs table is empty afterward.
async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  registerAggregate(t, "sortIndex");
  await t.mutation(api.collections.createCollection, {
    name: "products",
    searchFields: ["name"],
    storedFields: ["name"],
    facetFields: ["name"],
  });
  return t;
}

async function searchDocCount(t: any): Promise<number> {
  return await t.run(async (ctx: any) => {
    const rows = await ctx.db
      .query("searchDocs")
      .withIndex("by_collection_doc", (q: any) => q.eq("collection", "products"))
      .collect();
    return rows.length;
  });
}

describe("deleteCollection (single searchDocs table)", () => {
  it("removes every searchDocs row across multiple batches via self-scheduling", async () => {
    const t = await setup();
    const docs = Array.from({ length: 60 }, (_, i) => ({
      id: `p${i}`,
      doc: { name: `shoe ${i}` },
    }));
    for (const d of docs) {
      await t.mutation(api.write.upsert, { collection: "products", id: d.id, doc: d.doc });
    }
    expect(await searchDocCount(t)).toBe(60);

    await t.mutation(api.collections.deleteCollection, { name: "products" });
    await t.finishAllScheduledFunctions(() => {});

    expect(await searchDocCount(t)).toBe(0);
    const col = await t.query(api.collections.getCollection, { name: "products" });
    expect(col).toBeNull();
  });

  it("clears the facetCounts table for the collection", async () => {
    const t = await setup();
    for (let i = 0; i < 30; i++) {
      await t.mutation(api.write.upsert, { collection: "products", id: `p${i}`, doc: { name: "shoe" } });
    }
    await t.mutation(api.collections.deleteCollection, { name: "products" });
    await t.finishAllScheduledFunctions(() => {});
    const facetRows = await t.run(async (ctx: any) =>
      ctx.db
        .query("facetCounts")
        .withIndex("by_field", (q: any) => q.eq("collection", "products"))
        .collect(),
    );
    expect(facetRows.length).toBe(0);
  });
});
