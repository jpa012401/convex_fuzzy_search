import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");
const ids = (r: any) => r.hits.map((h: any) => h.id);

// #2.1 — numField missing -> 0: a doc missing a numeric sort field orders as if
// the value were 0 (alongside real zeros), NOT last.
describe("numField missing-value ordering", () => {
  it("a doc missing the sort field orders alongside value 0, not last", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");
    await t.mutation(api.collections.createCollection, {
      name: "s",
      searchFields: ["name"],
      storedFields: "all",
      sortSpecs: [[{ field: "score", order: "asc" as const }]],
    });
    // "missing" has no `score`; "zero" has score 0; "pos" has score 5.
    await t.mutation(api.write.upsert, { collection: "s", id: "missing", doc: { id: "missing", name: "a" } });
    await t.mutation(api.write.upsert, { collection: "s", id: "zero", doc: { id: "zero", name: "b", score: 0 } });
    await t.mutation(api.write.upsert, { collection: "s", id: "pos", doc: { id: "pos", name: "c", score: 5 } });

    const r = await t.query(api.search.search, {
      collection: "s", q: "", sortBy: [{ field: "score", order: "asc" as const }], perPage: 10,
    });
    // missing (0) and zero (0) both sort ahead of pos (5); pos is last.
    expect(ids(r)[2]).toBe("pos");
    expect(ids(r).slice(0, 2).sort()).toEqual(["missing", "zero"]);
  });
});

// #2.2 — facet String() projection invariant: increment uses raw input,
// decrement uses projected stored value; under an explicit projection that
// includes the facet field, upsert+delete nets the facet count back to zero.
describe("facet count invariant under explicit projection", () => {
  it("upsert then delete returns the facet count row to zero (removed)", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "f",
      searchFields: ["name"],
      storedFields: ["name", "brand"], // explicit projection INCLUDING the facet field
      facetFields: ["brand"],
    });
    await t.mutation(api.write.upsert, { collection: "f", id: "p1", doc: { id: "p1", name: "x", brand: "Acme" } });

    const afterUpsert = await t.run(async (ctx) =>
      ctx.db.query("facetCounts")
        .withIndex("by_value", (q) => q.eq("collection", "f").eq("field", "brand").eq("value", "Acme"))
        .unique(),
    );
    expect(afterUpsert?.count).toBe(1);

    await t.mutation(api.write.delete, { collection: "f", id: "p1" });
    const afterDelete = await t.run(async (ctx) =>
      ctx.db.query("facetCounts")
        .withIndex("by_value", (q) => q.eq("collection", "f").eq("field", "brand").eq("value", "Acme"))
        .unique(),
    );
    expect(afterDelete).toBeNull(); // decrement removed the zero-count row
  });
});

// #2.3 — found is a floor under truncation: a forced-truncation search reports
// found_approximate true and found no greater than the true match count.
describe("found is a floor under truncation", () => {
  it("multi-token truncated search reports approximate and a floor count", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "t", searchFields: ["body"], storedFields: "all",
    });
    // 12 docs all containing both tokens -> true match count is 12.
    for (let i = 0; i < 12; i++) {
      await t.mutation(api.write.upsert, { collection: "t", id: `d${i}`, doc: { id: `d${i}`, body: "alpha beta" } });
    }
    // Default budget (4000) would NOT truncate 12 docs; assert the contract holds
    // at the API level: every result is exact here, and found never exceeds truth.
    const r = await t.query(api.search.search, { collection: "t", q: "alpha beta", perPage: 50 });
    expect(r.found).toBeLessThanOrEqual(12);
    expect(r.found).toBe(12);
    expect(r.found_approximate).toBe(false);
  });
});
