import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  registerAggregate(t, "sortIndex");
  // Per F9: applyCollectionConfig assigns + persists slotMap via assignSlots,
  // so an upsert can never run without a slotMap.
  await t.mutation(api.configSync.applyCollectionConfig, {
    config: {
      name: "products",
      searchFields: ["name"],
      storedFields: ["name"],
    },
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

describe("upsertMany (write-bounded, scheduler-chained)", () => {
  it("writes one searchDocs row per doc for a batch larger than the old fixed-50 cap", async () => {
    const t = await setup();
    const N = 120; // > old MAX_UPSERT_MANY_BATCH (50)
    const docs = Array.from({ length: N }, (_, i) => ({
      id: `p${i}`,
      doc: { name: `shoe ${i}` },
    }));
    await t.mutation(api.write.upsertMany, { collection: "products", docs });
    // Drain any self-scheduled continuation chain.
    await t.finishAllScheduledFunctions(() => {});
    expect(await searchDocCount(t)).toBe(N);
  });

  it("accepts > 50 docs without throwing", async () => {
    const t = await setup();
    const docs = Array.from({ length: 51 }, (_, i) => ({
      id: `q${i}`,
      doc: { name: "shoe" },
    }));
    await expect(
      t.mutation(api.write.upsertMany, { collection: "products", docs }),
    ).resolves.toBeNull();
  });
});
