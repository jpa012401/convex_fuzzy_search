import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
    filterFields: [
      { field: "brand", type: "string" },
      { field: "price", type: "number" },
    ],
    facetFields: ["brand"],
  });
  return t;
}
const filterRows = (t: any, docId: string) =>
  t.run((ctx: any) =>
    ctx.db.query("filters").withIndex("by_doc", (q: any) => q.eq("collection", "shop").eq("docId", docId)).collect(),
  );

describe("write path maintains filter rows", () => {
  it("writes string/number rows; skips missing/non-coercible; replaces; deletes", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "shoe", brand: "Aurora", price: 90 } });
    let rows = await filterRows(t, "p1");
    expect(rows.map((r: any) => `${r.field}:${r.strVal ?? r.numVal}`).sort()).toEqual(["brand:Aurora", "price:90"]);

    await t.mutation(api.write.upsert, { collection: "shop", id: "p2", doc: { name: "x", price: "NaNish" } });
    expect(await filterRows(t, "p2")).toEqual([]);

    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "shoe", brand: "Nimbus", price: 95 } });
    rows = await filterRows(t, "p1");
    expect(rows.map((r: any) => `${r.field}:${r.strVal ?? r.numVal}`).sort()).toEqual(["brand:Nimbus", "price:95"]);

    await t.mutation(api.write.delete, { collection: "shop", id: "p1" });
    expect(await filterRows(t, "p1")).toEqual([]);
  });

  it("deleteCollection clears filter rows", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Aurora", price: 1 } });
    await t.mutation(api.collections.deleteCollection, { name: "shop" });
    expect(await filterRows(t, "p1")).toEqual([]);
  });

  it("backfill rebuilds filter rows for pre-existing docs", async () => {
    const t = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("documents", { collection: "shop", docId: "z", stored: { name: "z", brand: "Aurora", price: 5 } });
    });
    expect(await filterRows(t, "z")).toEqual([]);
    let cursor: string | null = null;
    do {
      const r: any = await t.mutation(api.backfill.backfillFiltersPage, { collection: "shop", cursor, batch: 1 });
      cursor = r.cursor;
    } while (cursor !== null);
    const rows = await filterRows(t, "z");
    expect(rows.map((r: any) => `${r.field}:${r.strVal ?? r.numVal}`).sort()).toEqual(["brand:Aurora", "price:5"]);
  });
});
