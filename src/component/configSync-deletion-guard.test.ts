import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

// applyCollectionConfig (config-sync path) must block while a collection of the
// same name is still being torn down, exactly like createCollection does via
// blockIfDeletionInProgress. Without the guard a re-sync during async cleanup
// inserts a live row that coexists with index rows the background cleanup will
// then delete out from under it.
describe("applyCollectionConfig deletion guard", () => {
  it("rejects (or otherwise refuses) a re-sync while deletion is in progress", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");

    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "products", searchFields: ["name"], storedFields: "all" },
    });
    // Seed enough docs that cleanup cannot finish in the synchronous portion of
    // deleteCollection (DELETE_BATCH_SIZE * DELETE_BATCHES_PER_PUBLIC_CALL).
    await t.mutation(api.write.upsertMany, {
      collection: "products",
      docs: Array.from({ length: 30 }, (_, i) => ({
        id: `p${String(i).padStart(2, "0")}`,
        doc: { name: `shared searchable product ${i}` },
      })),
    });

    // Simulate the collection row being removed with index rows still present
    // (the state deleteCollection leaves while the async batch cleanup runs).
    await t.run(async (ctx) => {
      const c = await ctx.db
        .query("collections")
        .withIndex("by_name", (q) => q.eq("name", "products"))
        .unique();
      if (!c) throw new Error("missing collection");
      await ctx.db.insert("deletions", { name: "products", sortSpecs: [] });
      await ctx.db.delete(c._id);
    });

    // createCollection correctly refuses here.
    await expect(
      t.mutation(api.collections.createCollection, {
        name: "products",
        searchFields: ["name"],
      }),
    ).rejects.toThrow(/deletion in progress/);

    // applyCollectionConfig SHOULD also refuse, but today it happily re-creates
    // the row alongside the not-yet-deleted index rows.
    await expect(
      t.mutation(api.configSync.applyCollectionConfig, {
        config: { name: "products", searchFields: ["name"], storedFields: "all" },
      }),
    ).rejects.toThrow(/deletion in progress/);
  });
});
