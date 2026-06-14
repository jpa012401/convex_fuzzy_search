import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function seeded() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
    filterFields: [{ field: "brand", type: "string" }],
    facetFields: ["brand", "category"],
  });
  const docs = [
    { id: "1", doc: { name: "red shoe", brand: "Aurora", category: "Footwear" } },
    { id: "2", doc: { name: "blue shoe", brand: "Aurora", category: "Footwear" } },
    { id: "3", doc: { name: "green hat", brand: "Nimbus", category: "Hats" } },
  ];
  for (const d of docs) await t.mutation(api.write.upsert, { collection: "shop", ...d });
  return t;
}

describe("browse + facets served from counters", () => {
  it("returns global facet counts with no filter/text/sort", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "", facetBy: ["brand", "category"] });
    expect(r.found).toBe(3);
    expect(r.out_of).toBe(3);
    expect(r.facet_counts).toEqual([
      { field_name: "brand", counts: [{ value: "Aurora", count: 2 }, { value: "Nimbus", count: 1 }] },
      { field_name: "category", counts: [{ value: "Footwear", count: 2 }, { value: "Hats", count: 1 }] },
    ]);
    expect(r.hits.length).toBe(3);
  });

  it("rejects an undeclared facet field", async () => {
    const t = await seeded();
    await expect(
      t.query(api.search.search, { collection: "shop", q: "", facetBy: ["price"] }),
    ).rejects.toThrow(/not a declared facet field/);
  });

  it("query-scoped facets (with filter) stay exact over the matched set", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "brand:Aurora", facetBy: ["category"] });
    expect(r.found).toBe(2);
    expect(r.facet_counts).toEqual([
      { field_name: "category", counts: [{ value: "Footwear", count: 2 }] },
    ]);
  });

  it("query-scoped facets (with text) stay exact over the matched set", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "shoe", facetBy: ["brand"] });
    expect(r.found).toBe(2);
    expect(r.facet_counts).toEqual([
      { field_name: "brand", counts: [{ value: "Aurora", count: 2 }] },
    ]);
  });
});
