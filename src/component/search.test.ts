import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.collections.createCollection, {
    name: "products",
    searchFields: ["name", "description"],
  });
  const items = [
    { id: "p1", doc: { name: "Red Running Shoe", description: "for runners" } },
    { id: "p2", doc: { name: "Blue Running Jacket", description: "rain proof" } },
    { id: "p3", doc: { name: "Red Hat", description: "wool" } },
  ];
  await t.mutation(api.write.upsertMany, { collection: "products", docs: items });
  return t;
}

describe("search", () => {
  it("single token returns all matches with exact found", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, { collection: "products", q: "red" });
    expect(r.found).toBe(2);
    expect(r.out_of).toBe(3);
    expect(r.hits.map((h: any) => h.document.name).sort()).toEqual([
      "Red Hat",
      "Red Running Shoe",
    ]);
  });

  it("multi token is AND (all tokens must match)", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, {
      collection: "products",
      q: "red running",
    });
    expect(r.found).toBe(1);
    expect(r.hits[0].document.name).toBe("Red Running Shoe");
  });

  it("queryBy restricts matching fields", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, {
      collection: "products",
      q: "runners",
      queryBy: ["name"],
    });
    expect(r.found).toBe(0);
  });

  it("empty q matches all (browsing) with pagination", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, {
      collection: "products",
      q: "",
      page: 1,
      perPage: 2,
    });
    expect(r.found).toBe(3);
    expect(r.hits.length).toBe(2);
  });

  it("no match returns found 0 and empty hits with full envelope", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, { collection: "products", q: "zzz" });
    expect(r).toMatchObject({ found: 0, hits: [], facet_counts: [] });
    expect(typeof r.search_time_ms).toBe("number");
  });

  it("clamps perPage to at most 250 and page to at least 1", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, {
      collection: "products",
      q: "",
      page: 0,
      perPage: 9999,
    });
    expect(r.page).toBe(1);
    // 3 docs total, so the page still holds all 3, but the clamp must not throw
    // and must not page beyond bounds.
    expect(r.hits.length).toBe(3);
  });
});

describe("typo-tolerant prefix search", () => {
  it("prefix matches the last token (search-as-you-type)", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, { collection: "products", q: "run" });
    expect(r.found).toBe(2); // running (p1,p2) + runners (p1)
  });

  it("prefix only applies to the LAST token", async () => {
    const t = await setup();
    expect((await t.query(api.search.search, { collection: "products", q: "run shoe" })).found).toBe(0);
    expect((await t.query(api.search.search, { collection: "products", q: "shoe run" })).found).toBe(1);
  });

  it("tolerates a typo within budget", async () => {
    const t = await setup();
    expect((await t.query(api.search.search, { collection: "products", q: "runing" })).found).toBe(2);
  });

  it("rejects a typo that exceeds the budget", async () => {
    const t = await setup();
    // "runnixx" is edit-distance 2 from "running" (token len 7 -> budget 1) => no match.
    expect((await t.query(api.search.search, { collection: "products", q: "runnixx" })).found).toBe(0);
  });

  it("ranks exact above prefix above typo via text_match", async () => {
    const t = await setup();
    const exact = await t.query(api.search.search, { collection: "products", q: "running" });
    expect(exact.hits[0].text_match).toBe(3);
    const prefix = await t.query(api.search.search, { collection: "products", q: "run" });
    expect(prefix.hits[0].text_match).toBe(2);
    const typo = await t.query(api.search.search, { collection: "products", q: "runing" });
    expect(typo.hits[0].text_match).toBe(1.5);
  });
});

describe("filtering + faceting", () => {
  async function setupFacets() {
    const t = convexTest(schema, modules);
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
    await t.mutation(api.write.upsertMany, {
      collection: "shop",
      docs: [
        { id: "1", doc: { name: "running shoe", brand: "Aurora", price: 90 } },
        { id: "2", doc: { name: "trail shoe", brand: "Aurora", price: 110 } },
        { id: "3", doc: { name: "rain jacket", brand: "Nimbus", price: 150 } },
      ],
    });
    return t;
  }

  it("filterBy narrows the result set", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "brand:Aurora" });
    expect(r.found).toBe(2);
  });

  it("numeric comparator filter", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "price:>100" });
    expect(r.found).toBe(2);
  });

  it("filter combines with a text query (intersection)", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "shoe", filterBy: "brand:Aurora" });
    expect(r.found).toBe(2);
  });

  it("facet_counts reflect the filtered+searched set, sorted by count desc", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", facetBy: ["brand"] });
    expect(r.facet_counts).toEqual([
      { field_name: "brand", counts: [ { value: "Aurora", count: 2 }, { value: "Nimbus", count: 1 } ] },
    ]);
  });

  it("maxFacetValues caps the number of values", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", facetBy: ["brand"], maxFacetValues: 1 });
    expect(r.facet_counts[0].counts).toEqual([{ value: "Aurora", count: 2 }]);
  });

  it("facet over a filtered set is query-scoped", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "price:>100", facetBy: ["brand"] });
    expect(r.facet_counts[0].counts).toEqual([
      { value: "Aurora", count: 1 },
      { value: "Nimbus", count: 1 },
    ]);
  });

  it("absent facetBy yields empty facet_counts", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "" });
    expect(r.facet_counts).toEqual([]);
  });

  it("throws on a facet field not declared", async () => {
    const t = await setupFacets();
    await expect(
      t.query(api.search.search, { collection: "shop", q: "", facetBy: ["price"] }),
    ).rejects.toThrow(/facet/i);
  });
});
