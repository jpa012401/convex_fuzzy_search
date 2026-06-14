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

  it("backfill rebuilds sort entries for pre-existing docs (idempotent)", async () => {
    const t = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("documents", { collection: "shop", docId: "z1", stored: { name: "a", price: 30 } });
      await ctx.db.insert("documents", { collection: "shop", docId: "z2", stored: { name: "b", price: 10 } });
    });
    expect(await pageAsc(t)).toEqual([]);
    const runBackfill = async () => {
      let cursor: string | null = null;
      do {
        const r: any = await t.mutation(api.backfill.backfillSortIndexPage, { collection: "shop", cursor, batch: 1 });
        cursor = r.cursor;
      } while (cursor !== null);
    };
    await runBackfill();
    expect(await pageAsc(t)).toEqual(["z2", "z1"]);
    await runBackfill(); // insertIfDoesNotExist -> idempotent
    expect(await pageAsc(t)).toEqual(["z2", "z1"]);
  });

  // Regression: a string-join namespace ("collection specId") would alias
  // ("x a","b:asc") with ("x","a b:asc"); the tuple namespace keeps them apart.
  it("does not alias namespaces when names contain spaces", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");
    await t.mutation(api.collections.createCollection, {
      name: "x a",
      searchFields: ["name"],
      storedFields: "all",
      sortSpecs: [[{ field: "b", order: "asc" as const }]],
    });
    await t.mutation(api.collections.createCollection, {
      name: "x",
      searchFields: ["name"],
      storedFields: "all",
      sortSpecs: [[{ field: "a b", order: "asc" as const }]],
    });
    await t.mutation(api.write.upsert, { collection: "x a", id: "p", doc: { name: "p", b: 1 } });
    await t.mutation(api.write.upsert, { collection: "x", id: "q", doc: { name: "q", "a b": 2 } });
    const page = (col: string, specId: string) =>
      t.run((ctx: any) => pageSortedDocIds(ctx, col, specId, 0, 10));
    expect(await page("x a", "b:asc")).toEqual(["p"]);
    expect(await page("x", "a b:asc")).toEqual(["q"]);
  });
});
