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

  it("filtered facet counts come from the inverted index and match a brute tally", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "fs",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [
        { field: "inStock", type: "string" as const },
        { field: "category", type: "string" as const },
      ],
      facetFields: ["category"],
    });
    // 6 docs: 4 in stock (2 Eng, 2 Sales), 2 out (1 Eng, 1 Sales).
    const docs = [
      { id: "1", doc: { name: "a", inStock: "true", category: "Eng" } },
      { id: "2", doc: { name: "b", inStock: "true", category: "Eng" } },
      { id: "3", doc: { name: "c", inStock: "true", category: "Sales" } },
      { id: "4", doc: { name: "d", inStock: "true", category: "Sales" } },
      { id: "5", doc: { name: "e", inStock: "false", category: "Eng" } },
      { id: "6", doc: { name: "f", inStock: "false", category: "Sales" } },
    ];
    await t.mutation(api.write.upsertMany, { collection: "fs", docs });
    const r = await t.query(api.search.search, {
      collection: "fs", q: "", filterBy: "inStock:true", facetBy: ["category"],
    });
    const counts = Object.fromEntries(
      (r.facet_counts.find((f: any) => f.field_name === "category")?.counts ?? []).map((c: any) => [c.value, c.count]),
    );
    // Among inStock=true only: Eng 2, Sales 2 (the out-of-stock docs excluded).
    expect(counts).toEqual({ Eng: 2, Sales: 2 });
    expect(r.found).toBe(4);
  });

  it("text+filter+facet counts over the text-narrowed set, not the whole filter", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "tff",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }, { field: "category", type: "string" as const }],
      facetFields: ["category"],
    });
    // brand=Acme has 3 docs across 2 categories, but only 2 contain "shoe".
    const docs = [
      { id: "1", doc: { name: "red shoe", brand: "Acme", category: "Footwear" } },
      { id: "2", doc: { name: "blue shoe", brand: "Acme", category: "Footwear" } },
      { id: "3", doc: { name: "wool hat", brand: "Acme", category: "Hats" } },
    ];
    await t.mutation(api.write.upsertMany, { collection: "tff", docs });
    const r = await t.query(api.search.search, {
      collection: "tff", q: "shoe", filterBy: "brand:Acme", facetBy: ["category"],
    });
    const counts = Object.fromEntries(
      (r.facet_counts.find((f: any) => f.field_name === "category")?.counts ?? []).map((c: any) => [c.value, c.count]),
    );
    // Only the 2 "shoe" docs match -> Footwear:2, and Hats must NOT appear
    // (doc 3 is brand:Acme but has no "shoe"). If the index path ignored text,
    // Hats:1 would wrongly appear.
    expect(counts).toEqual({ Footwear: 2 });
    expect(r.found).toBe(2);
  });
});
