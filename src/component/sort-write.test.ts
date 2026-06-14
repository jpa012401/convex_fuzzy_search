import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { pageSortedDocIds } from "./sortIndex";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  registerAggregate(t, "sortIndex");
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
    sortSpecs: [
      [{ field: "price", order: "asc" as const }],
      [{ field: "price", order: "desc" as const }],
    ],
  });
  return t;
}
const pageAsc = (t: any) => t.run((ctx: any) => pageSortedDocIds(ctx, "shop", "price:asc", 0, 10));

describe("write path maintains sort index", () => {
  it("upsert adds entries; page returns docs in ascending price", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "a", doc: { name: "a", price: 30 } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "b", doc: { name: "b", price: 10 } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "c", doc: { name: "c", price: 20 } });
    expect(await pageAsc(t)).toEqual(["b", "c", "a"]);
  });

  it("replace moves the entry to its new position", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "a", doc: { name: "a", price: 30 } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "b", doc: { name: "b", price: 10 } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "a", doc: { name: "a", price: 5 } });
    expect(await pageAsc(t)).toEqual(["a", "b"]);
  });

  it("delete removes the entry", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "a", doc: { name: "a", price: 30 } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "b", doc: { name: "b", price: 10 } });
    await t.mutation(api.write.delete, { collection: "shop", id: "a" });
    expect(await pageAsc(t)).toEqual(["b"]);
  });

  it("deleteCollection clears sort entries", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "a", doc: { name: "a", price: 30 } });
    await t.mutation(api.collections.deleteCollection, { name: "shop" });
    await t.mutation(api.collections.createCollection, {
      name: "shop",
      searchFields: ["name"],
      storedFields: "all",
      sortSpecs: [[{ field: "price", order: "asc" as const }]],
    });
    expect(await pageAsc(t)).toEqual([]);
  });
});
