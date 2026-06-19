import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { readStringPostingDocKeys } from "./filterPostings";
import { resolveAstToDocIds, parseFilterAst, FILTER_RESULT_BUDGET } from "./filter";

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

    // Pre-existing doc has NO filterPostings for brand (brand isn't a filter field yet).
    const preKeys = await t.run((ctx: any) =>
      readStringPostingDocKeys(ctx, "c", "brand", "Aurora", 1000),
    );
    expect(preKeys.docKeys).toEqual([]);

    // 2. Add brand as a filter field via sync -> flagged pending.
    const applied = await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "c", searchFields: ["name"], storedFields: "derived", filterFields: [{ field: "brand", type: "string" }] },
    });
    expect(applied.pendingFields).toContain("brand");
    const flagged = await t.query(api.collections.getCollection, { name: "c" });
    expect(flagged?.pendingFields).toContain("brand");

    // Still no filterPostings for brand — sync does NOT touch docs.
    const midKeys = await t.run((ctx: any) =>
      readStringPostingDocKeys(ctx, "c", "brand", "Aurora", 1000),
    );
    expect(midKeys.docKeys).toEqual([]);

    // While brand is pending and the doc has NOT been replayed, resolveAstToDocIds
    // returns complete === false (migration guard: do not trust the empty index).
    const pendingComplete = await t.run(async (ctx: any) => {
      const r = await resolveAstToDocIds(
        ctx,
        "c",
        parseFilterAst("brand:Aurora", { brand: "string" }),
        FILTER_RESULT_BUDGET,
        new Set(["brand"]),
      );
      return r.complete;
    });
    expect(pendingComplete).toBe(false);

    // 3. App-driven reindex: replay the doc through upsert (the app would page
    //    its own table; here we replay the one doc with its full data).
    await t.mutation(api.write.upsert, { collection: "c", id: "p1", doc: { name: "aurora shoe", brand: "Aurora" } });

    // Now the brand filterPosting exists.
    const replayedKeys = await t.run((ctx: any) =>
      readStringPostingDocKeys(ctx, "c", "brand", "Aurora", 1000),
    );
    expect(replayedKeys.docKeys.length).toBe(1);

    // And the filter is queryable via search.
    const filtered = await t.query(api.search.search, { collection: "c", q: "", filterBy: "brand:Aurora" });
    expect(filtered.hits.map((h: any) => h.id)).toEqual(["p1"]);

    // 4. Clear pending -> fully reindexed. resolve with empty pending set returns complete === true.
    await t.mutation(api.configSync.clearPendingFields, { collection: "c" });
    const cleared = await t.query(api.collections.getCollection, { name: "c" });
    expect(cleared?.pendingFields ?? []).toEqual([]);

    const clearedComplete = await t.run(async (ctx: any) => {
      const r = await resolveAstToDocIds(
        ctx,
        "c",
        parseFilterAst("brand:Aurora", { brand: "string" }),
        FILTER_RESULT_BUDGET,
        new Set(),
      );
      return r.complete;
    });
    expect(clearedComplete).toBe(true);
  });

  it("replaying a doc populates filterPostings and facetPostings", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "bf",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }],
      facetFields: ["brand"],
    });
    // Upsert a doc — write path populates both filterPostings and facetPostings.
    await t.mutation(api.write.upsert, { collection: "bf", id: "a", doc: { name: "x", brand: "Acme" } });
    // Replay (what reindex does): upsert the same doc again.
    await t.mutation(api.write.upsert, { collection: "bf", id: "a", doc: { name: "x", brand: "Acme" } });
    const { filterDocKeyCount, facetDocKeyCount } = await t.run(async (ctx: any) => {
      const fp = await readStringPostingDocKeys(ctx, "bf", "brand", "Acme", 1000);
      const post = await ctx.db
        .query("facetPostings")
        .withIndex("by_collection_field_value", (q: any) =>
          q.eq("collection", "bf").eq("field", "brand").eq("value", "Acme"),
        )
        .collect();
      return {
        filterDocKeyCount: fp.docKeys.length,
        facetDocKeyCount: post.flatMap((r: any) => r.docKeys).length,
      };
    });
    expect(filterDocKeyCount).toBe(1);
    expect(facetDocKeyCount).toBe(1);
  });
});
