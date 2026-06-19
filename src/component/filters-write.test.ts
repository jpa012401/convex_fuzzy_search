import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { readStringPostingDocKeys, readNumericRangeDocKeys } from "./filterPostings";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
    filterFields: [
      { field: "brand", type: "string" as const },
      { field: "price", type: "number" as const },
    ],
  });
  return t;
}

describe("write path maintains filterPostings", () => {
  it("upsert adds string + numeric postings; delete removes them", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "shop",
      id: "a",
      doc: { name: "x", brand: "Aurora", price: 90 },
    });

    const after = await t.run(async (ctx) => ({
      brand: (await readStringPostingDocKeys(ctx, "shop", "brand", "Aurora", 1000)).docKeys.length,
      price: (await readNumericRangeDocKeys(ctx, "shop", "price", 90, 90, true, true, 1000)).docKeys.length,
    }));
    expect(after).toEqual({ brand: 1, price: 1 });

    await t.mutation(api.write.delete, { collection: "shop", id: "a" });
    const afterDel = await t.run(async (ctx) => ({
      brand: (await readStringPostingDocKeys(ctx, "shop", "brand", "Aurora", 1000)).docKeys.length,
      price: (await readNumericRangeDocKeys(ctx, "shop", "price", 90, 90, true, true, 1000)).docKeys.length,
    }));
    expect(afterDel).toEqual({ brand: 0, price: 0 });
  });

  it("re-upsert with changed value moves the posting (no stale key)", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "shop",
      id: "a",
      doc: { name: "x", brand: "Aurora", price: 90 },
    });
    await t.mutation(api.write.upsert, {
      collection: "shop",
      id: "a",
      doc: { name: "x", brand: "Nimbus", price: 150 },
    });
    const counts = await t.run(async (ctx) => ({
      aurora: (await readStringPostingDocKeys(ctx, "shop", "brand", "Aurora", 1000)).docKeys.length,
      nimbus: (await readStringPostingDocKeys(ctx, "shop", "brand", "Nimbus", 1000)).docKeys.length,
      p90: (await readNumericRangeDocKeys(ctx, "shop", "price", 90, 90, true, true, 1000)).docKeys.length,
      p150: (await readNumericRangeDocKeys(ctx, "shop", "price", 150, 150, true, true, 1000)).docKeys.length,
    }));
    expect(counts).toEqual({ aurora: 0, nimbus: 1, p90: 0, p150: 1 });
  });

  it("skips missing / non-coercible values — no posting created", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "shop",
      id: "b",
      doc: { name: "x", price: "NaNish" },
    });
    const counts = await t.run(async (ctx) => ({
      // no brand field on doc — string posting should be absent
      brand: (await readStringPostingDocKeys(ctx, "shop", "brand", "NaNish", 1000)).docKeys.length,
      // price is non-numeric — numeric postings over all finite range should be absent
      price: (await readNumericRangeDocKeys(
        ctx,
        "shop",
        "price",
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        true,
        true,
        1000,
      )).docKeys.length,
    }));
    expect(counts).toEqual({ brand: 0, price: 0 });
  });

  it("deleteCollection clears filterPostings", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "shop",
      id: "c",
      doc: { name: "x", brand: "Aurora", price: 1 },
    });
    // deleteCollection runs up to 64 batches of 25 synchronously, so 1 doc clears immediately.
    await t.mutation(api.collections.deleteCollection, { name: "shop" });
    const leftover = await t.run(async (ctx) => ({
      brand: (await readStringPostingDocKeys(ctx, "shop", "brand", "Aurora", 1000)).docKeys.length,
      price: (await readNumericRangeDocKeys(ctx, "shop", "price", 1, 1, true, true, 1000)).docKeys.length,
    }));
    expect(leftover).toEqual({ brand: 0, price: 0 });
  });
});
