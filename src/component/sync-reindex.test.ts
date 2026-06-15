import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

const filterRows = (t: any, collection: string, docId: string) =>
  t.run((ctx: any) =>
    ctx.db.query("filters").withIndex("by_doc", (q: any) => q.eq("collection", collection).eq("docId", docId)).collect(),
  );

describe("config sync + app-driven reindex (component level)", () => {
  it("adding a filter field flags pending; replaying docs via upsert backfills it; clearPending resets", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");

    // 1. Create a collection WITHOUT the brand filter, index one doc.
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "c", searchFields: ["name"], storedFields: "derived" },
    });
    await t.mutation(api.write.upsert, { collection: "c", id: "p1", doc: { name: "aurora shoe", brand: "Aurora" } });

    // Pre-existing doc has NO filter rows yet (brand isn't a filter field).
    expect(await filterRows(t, "c", "p1")).toEqual([]);

    // 2. Add brand as a filter field via sync -> flagged pending.
    const applied = await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "c", searchFields: ["name"], storedFields: "derived", filterFields: [{ field: "brand", type: "string" }] },
    });
    expect(applied.pendingFields).toContain("brand");
    const flagged = await t.query(api.collections.getCollection, { name: "c" });
    expect(flagged?.pendingFields).toContain("brand");

    // Still no filter rows for the pre-existing doc — sync does NOT touch docs.
    expect(await filterRows(t, "c", "p1")).toEqual([]);

    // 3. App-driven reindex: replay the doc through upsert (the app would page
    //    its own table; here we replay the one doc with its full data).
    await t.mutation(api.write.upsert, { collection: "c", id: "p1", doc: { name: "aurora shoe", brand: "Aurora" } });

    // Now the brand filter row exists.
    const rows = await filterRows(t, "c", "p1");
    expect(rows.map((r: any) => `${r.field}:${r.strVal ?? r.numVal}`)).toEqual(["brand:Aurora"]);

    // And the filter is queryable via search.
    const filtered = await t.query(api.search.search, { collection: "c", q: "", filterBy: "brand:Aurora" });
    expect(filtered.hits.map((h: any) => h.id)).toEqual(["p1"]);

    // 4. Clear pending -> fully reindexed.
    await t.mutation(api.configSync.clearPendingFields, { collection: "c" });
    const cleared = await t.query(api.collections.getCollection, { name: "c" });
    expect(cleared?.pendingFields ?? []).toEqual([]);
  });
});
