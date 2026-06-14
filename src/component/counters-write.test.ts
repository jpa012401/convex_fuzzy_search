import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { collectionCount } from "./counters";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, { name: "products", searchFields: ["name"] });
  return t;
}

describe("write path maintains the counter", () => {
  it("increments on new, is stable on re-upsert, decrements on delete", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "red shoe" } });
    await t.mutation(api.write.upsert, { collection: "products", id: "p2", doc: { name: "blue hat" } });
    expect(await t.run((ctx) => collectionCount(ctx, "products"))).toBe(2);
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "green shoe" } });
    expect(await t.run((ctx) => collectionCount(ctx, "products"))).toBe(2);
    await t.mutation(api.write.delete, { collection: "products", id: "p1" });
    expect(await t.run((ctx) => collectionCount(ctx, "products"))).toBe(1);
  });

  it("deleteCollection clears the namespace count", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "x" } });
    await t.mutation(api.collections.deleteCollection, { name: "products" });
    expect(await t.run((ctx) => collectionCount(ctx, "products"))).toBe(0);
  });

  it("backfill rebuilds the counter for pre-existing docs", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, { name: "products", searchFields: ["name"] });
    // insert documents directly, bypassing the counter, to simulate pre-S1 data
    await t.run(async (ctx) => {
      await ctx.db.insert("documents", { collection: "products", docId: "x", stored: { name: "x" } });
      await ctx.db.insert("documents", { collection: "products", docId: "y", stored: { name: "y" } });
    });
    expect(await t.run((ctx) => collectionCount(ctx, "products"))).toBe(0);
    let cursor: string | null = null;
    do {
      const r: any = await t.mutation(api.backfill.backfillCounterPage, { collection: "products", cursor, batch: 1 });
      cursor = r.cursor;
    } while (cursor !== null);
    expect(await t.run((ctx) => collectionCount(ctx, "products"))).toBe(2);
  });
});
