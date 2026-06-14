import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function seeded() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  registerAggregate(t, "sortIndex");
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
    facetFields: ["category"],
    sortSpecs: [
      [{ field: "price", order: "asc" as const }],
      [{ field: "price", order: "desc" as const }],
      [{ field: "rating", order: "desc" as const }, { field: "price", order: "asc" as const }],
    ],
  });
  const docs = [
    { id: "1", doc: { id: "1", name: "a", price: 30, rating: 5, category: "X" } },
    { id: "2", doc: { id: "2", name: "b", price: 10, rating: 3, category: "Y" } },
    { id: "3", doc: { id: "3", name: "c", price: 20, rating: 5, category: "X" } },
  ];
  for (const d of docs) await t.mutation(api.write.upsert, { collection: "shop", ...d });
  return t;
}
const ids = (r: any) => r.hits.map((h: any) => h.document.id);

describe("browse + sort served from the sort index", () => {
  it("single-key price asc (declared) pages in order, found === out_of", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "", sortBy: [{ field: "price", order: "asc" }] });
    expect(ids(r)).toEqual(["2", "3", "1"]);
    expect(r.found).toBe(3);
    expect(r.out_of).toBe(3);
  });

  it("single-key price desc (declared)", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "", sortBy: [{ field: "price", order: "desc" }] });
    expect(ids(r)).toEqual(["1", "3", "2"]);
  });

  it("multi-key rating desc, price asc (declared)", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      sortBy: [{ field: "rating", order: "desc" }, { field: "price", order: "asc" }],
    });
    expect(ids(r)).toEqual(["3", "1", "2"]);
  });

  it("browse + sort + facets reads facet_counts from counters", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      sortBy: [{ field: "price", order: "asc" }],
      facetBy: ["category"],
    });
    expect(ids(r)).toEqual(["2", "3", "1"]);
    expect(r.facet_counts).toEqual([
      { field_name: "category", counts: [{ value: "X", count: 2 }, { value: "Y", count: 1 }] },
    ]);
  });

  it("undeclared sort (rating asc) falls back to full-load with correct order", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "", sortBy: [{ field: "rating", order: "asc" }] });
    expect(ids(r)).toEqual(["2", "1", "3"]);
    expect(r.found).toBe(3);
  });

  it("rankBy falls back to full-load with correct order", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      rankBy: { text: 0, fields: [{ field: "price", weight: 1 }] },
    });
    expect(ids(r)).toEqual(["1", "3", "2"]);
  });
});
