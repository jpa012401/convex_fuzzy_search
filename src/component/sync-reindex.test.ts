import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

describe("config sync + app-driven reindex (component level)", () => {
  it("adding a filter field flags pending; replaying docs via upsert backfills it; clearPending resets", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");

    // 1. Create a collection WITHOUT the brand filter, index one doc.
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "c", searchFields: ["name"], storedFields: "derived" },
    });
    await t.mutation(api.write.upsert, { collection: "c", id: "p1", doc: { name: "aurora shoe", brand: "Aurora" } });

    // 2. Add brand as a filter field via sync -> flagged pending.
    const applied = await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "c", searchFields: ["name"], storedFields: "derived", filterFields: [{ field: "brand", type: "string" }] },
    });
    expect(applied.pendingFields).toContain("brand");
    const flagged = await t.query(api.collections.getCollection, { name: "c" });
    expect(flagged?.pendingFields).toContain("brand");

    // 3. App-driven reindex: replay the doc through upsert (the app would page
    //    its own table; here we replay the one doc with its full data).
    await t.mutation(api.write.upsert, { collection: "c", id: "p1", doc: { name: "aurora shoe", brand: "Aurora" } });

    // The filter is queryable via search (uses searchDocs slot-based path).
    const filtered = await t.query(api.search.search, { collection: "c", q: "", filterBy: "brand:Aurora" });
    expect(filtered.hits.map((h: any) => h.id)).toEqual(["p1"]);

    // 4. Clear pending -> fully reindexed.
    await t.mutation(api.configSync.clearPendingFields, { collection: "c" });
    const cleared = await t.query(api.collections.getCollection, { name: "c" });
    expect(cleared?.pendingFields ?? []).toEqual([]);
  });

  it("replaying a doc populates searchDocs and facetCounts", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "bf",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }],
      facetFields: ["brand"],
    });
    // Upsert a doc — write path populates searchDocs and facetCounts.
    await t.mutation(api.write.upsert, { collection: "bf", id: "a", doc: { name: "x", brand: "Acme" } });
    // Replay (what reindex does): upsert the same doc again.
    await t.mutation(api.write.upsert, { collection: "bf", id: "a", doc: { name: "x", brand: "Acme" } });
    const { searchDocCount, facetCount } = await t.run(async (ctx: any) => {
      const searchDocs = await ctx.db
        .query("searchDocs")
        .withIndex("by_collection_doc", (q: any) => q.eq("collection", "bf"))
        .collect();
      const facetRows = await ctx.db
        .query("facetCounts")
        .withIndex("by_value", (q: any) =>
          q.eq("collection", "bf").eq("field", "brand").eq("value", "Acme"),
        )
        .collect();
      return {
        searchDocCount: searchDocs.length,
        facetCount: facetRows.reduce((s: number, r: any) => s + r.count, 0),
      };
    });
    expect(searchDocCount).toBe(1); // idempotent upsert: one row per doc
    expect(facetCount).toBe(1);
  });
});
