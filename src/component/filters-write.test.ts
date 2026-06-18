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

  it("writes docKey on filter rows", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "fk",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }],
    });
    await t.mutation(api.write.upsert, { collection: "fk", id: "x1", doc: { name: "a", brand: "Acme" } });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("filters").withIndex("by_doc", (q) => q.eq("collection", "fk").eq("docId", "x1")).collect(),
    );
    expect(rows.length).toBe(1);
    expect(typeof rows[0].docKey).toBe("number");
  });
});
