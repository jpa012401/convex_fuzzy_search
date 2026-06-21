import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

// DELETE_BATCH_SIZE=25, DELETE_BATCHES_PER_PUBLIC_CALL=64 -> one public call
// clears up to 25*64=1600 rows. Seed > one batch (60) so we exercise the loop,
// and assert the searchDocs table is empty afterward.
async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  registerAggregate(t, "sortIndex");
  await t.mutation(api.collections.createCollection, {
    name: "products",
    searchFields: ["name"],
    storedFields: ["name"],
    facetFields: ["name"],
  });
  return t;
}

async function searchDocCount(t: any): Promise<number> {
  return await t.run(async (ctx: any) => {
    const rows = await ctx.db
      .query("searchDocs")
      .withIndex("by_collection_doc", (q: any) => q.eq("collection", "products"))
      .collect();
    return rows.length;
  });
}

describe("deleteCollection (single searchDocs table)", () => {
  it("removes every searchDocs row across multiple batches via self-scheduling", async () => {
    const t = await setup();
    const docs = Array.from({ length: 60 }, (_, i) => ({
      id: `p${i}`,
      doc: { name: `shoe ${i}` },
    }));
    for (const d of docs) {
      await t.mutation(api.write.upsert, { collection: "products", id: d.id, doc: d.doc });
    }
    expect(await searchDocCount(t)).toBe(60);

    await t.mutation(api.collections.deleteCollection, { name: "products" });
    await t.finishAllScheduledFunctions(() => {});

    expect(await searchDocCount(t)).toBe(0);
    const col = await t.query(api.collections.getCollection, { name: "products" });
    expect(col).toBeNull();
  });

  // DELETE_BATCH_SIZE=25 * DELETE_BATCHES_PER_PUBLIC_CALL=64 = 1600 rows per
  // public deleteCollection call. Seeding 1650 rows forces the scheduler
  // self-scheduling continuation path (ctx.scheduler.runAfter) to fire — the
  // most important part of bounded deletion that the 60-row test misses.
  it("crosses the 1600-row public-call boundary and completes via self-scheduled continuation", async () => {
    const SEED_COUNT = 1650;
    const t = await setup();

    // Insert searchDocs rows directly to avoid 1650 full upsert mutations.
    // Split into two t.run batches to keep individual transactions reasonable.
    const half = Math.ceil(SEED_COUNT / 2);
    await t.run(async (ctx: any) => {
      for (let i = 0; i < half; i++) {
        await ctx.db.insert("searchDocs", {
          collection: "products",
          docId: `bulk${i}`,
          stored: {},
        });
      }
    });
    await t.run(async (ctx: any) => {
      for (let i = half; i < SEED_COUNT; i++) {
        await ctx.db.insert("searchDocs", {
          collection: "products",
          docId: `bulk${i}`,
          stored: {},
        });
      }
    });
    expect(await searchDocCount(t)).toBe(SEED_COUNT);

    // deleteCollection handles up to 1600 rows inline; remaining 50 rows are
    // cleaned up via ctx.scheduler.runAfter -> internal.collections.cleanupCollectionBatch.
    await t.mutation(api.collections.deleteCollection, { name: "products" });
    // Yield to the macrotask queue so the setTimeout(fn, 0) from runAfter(0, ...)
    // fires and registers the scheduled function as in-flight before
    // finishAllScheduledFunctions checks anyFunctionsRunning().
    await new Promise((r) => setTimeout(r, 10));
    // finishAllScheduledFunctions drains all scheduled continuations until
    // the queue is empty, exercising the self-scheduling path.
    await t.finishAllScheduledFunctions(() => {});

    expect(await searchDocCount(t)).toBe(0);
    const col = await t.query(api.collections.getCollection, { name: "products" });
    expect(col).toBeNull();
  });

  it("clears the facetCounts table for the collection", async () => {
    const t = await setup();
    for (let i = 0; i < 30; i++) {
      await t.mutation(api.write.upsert, { collection: "products", id: `p${i}`, doc: { name: "shoe" } });
    }
    await t.mutation(api.collections.deleteCollection, { name: "products" });
    await t.finishAllScheduledFunctions(() => {});
    const facetRows = await t.run(async (ctx: any) =>
      ctx.db
        .query("facetCounts")
        .withIndex("by_field", (q: any) => q.eq("collection", "products"))
        .collect(),
    );
    expect(facetRows.length).toBe(0);
  });

  // C1: deleteCollection must drain terms + trigrams so a same-named re-created
  // collection doesn't inherit stale vocabulary (inflated docCounts / phantom
  // typo suggestions). Seeds 30 docs with unique terms to populate the dictionary,
  // then asserts ZERO terms and ZERO trigrams remain after deletion is drained.
  it("clears the terms and trigrams tables for the collection after delete", async () => {
    const t = await setup();
    // Seed docs with unique search text so each inserts distinct term rows.
    for (let i = 0; i < 30; i++) {
      await t.mutation(api.write.upsert, {
        collection: "products",
        id: `p${i}`,
        doc: { name: `uniqueword${i}` },
      });
    }
    // Verify terms were actually written before we delete.
    const termsBefore = await t.run(async (ctx: any) =>
      ctx.db
        .query("terms")
        .withIndex("by_collection_term", (q: any) => q.eq("collection", "products"))
        .collect(),
    );
    expect(termsBefore.length).toBeGreaterThan(0);

    await t.mutation(api.collections.deleteCollection, { name: "products" });
    await t.finishAllScheduledFunctions(() => {});

    const termsAfter = await t.run(async (ctx: any) =>
      ctx.db
        .query("terms")
        .withIndex("by_collection_term", (q: any) => q.eq("collection", "products"))
        .collect(),
    );
    expect(termsAfter.length).toBe(0);

    const trigramsAfter = await t.run(async (ctx: any) =>
      ctx.db
        .query("trigrams")
        .withIndex("by_collection_term", (q: any) => q.eq("collection", "products"))
        .collect(),
    );
    expect(trigramsAfter.length).toBe(0);
  });
});
