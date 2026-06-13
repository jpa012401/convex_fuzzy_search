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
});
