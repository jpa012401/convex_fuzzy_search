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
    facetFields: ["brand"],
  });
  const docs = [
    { id: "1", doc: { id: "1", name: "waterproof shoe", brand: "A" } },
    { id: "2", doc: { id: "2", name: "running shoe", brand: "B" } },
    { id: "3", doc: { id: "3", name: "leather shoe", brand: "A" } },
  ];
  for (const d of docs) await t.mutation(api.write.upsert, { collection: "shop", ...d });
  return t;
}

describe("found_approximate is present and exact by default", () => {
  it("text query: exact found, flag false", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "shoe" });
    expect(r.found).toBe(3);
    expect(r.found_approximate).toBe(false);
  });

  it("multi-term AND text query is exact", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "waterproof shoe" });
    expect(r.found).toBe(1);
    expect(r.found_approximate).toBe(false);
  });

  it("browse path reports found_approximate false", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "" });
    expect(r.found).toBe(3);
    expect(r.found_approximate).toBe(false);
  });

  it("filter path reports found_approximate false", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "brand:A" });
    expect(r.found).toBe(2);
    expect(r.found_approximate).toBe(false);
  });
});
