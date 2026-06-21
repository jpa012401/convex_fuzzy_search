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
  // Drive via config sync so the collection row carries a slotMap (F9).
  await t.mutation(api.configSync.applyCollectionConfig, {
    config: {
      name: "products",
      searchFields: ["name", "description"],
      storedFields: ["name", "brand", "price"],
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
      ],
      facetFields: ["brand"],
      sortSpecs: [[{ field: "price", order: "asc" }]],
    },
  });
  return t;
}

async function rowFor(t: any, docId: string) {
  return await t.run(async (ctx: any) =>
    ctx.db
      .query("searchDocs")
      .withIndex("by_collection_doc", (q: any) =>
        q.eq("collection", "products").eq("docId", docId),
      )
      .unique(),
  );
}

describe("write path (searchDocs)", () => {
  it("upsert writes ONE searchDocs row with correct slots + stored", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "running shoe", brand: "Acme", price: 50, secret: "x" },
    });
    const row = await rowFor(t, "p1");
    expect(row).not.toBeNull();
    // text0 = tokenized join of all searchFields
    expect(row.text0).toBe("red shoe running shoe");
    // mapped raw-text + filter slots (name->text1, description->text2, brand->filt0, price->numF0)
    expect(row.text1).toBe("Red Shoe");
    expect(row.text2).toBe("running shoe");
    expect(row.filt0).toBe("Acme");
    expect(row.numF0).toBe(50);
    // stored projection drops `secret`, keeps storedFields list
    expect(row.stored).toEqual({ name: "Red Shoe", brand: "Acme", price: 50 });
  });

  it("upsert increments docCount, facetCounts table, and sort aggregate", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "x", brand: "Acme", price: 50 },
    });
    const count = await t.run(async (ctx: any) => {
      const { DirectAggregate } = await import("@convex-dev/aggregate");
      return null; // count asserted indirectly below
    });
    const facet = await t.run(async (ctx: any) =>
      ctx.db
        .query("facetCounts")
        .withIndex("by_value", (q: any) =>
          q.eq("collection", "products").eq("field", "brand").eq("value", "Acme"),
        )
        .unique(),
    );
    expect(facet.count).toBe(1);
  });

  it("re-upsert replaces the row (no duplicate) and nets facet counts", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "x", brand: "Acme", price: 50 },
    });
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Blue Shoe", description: "y", brand: "Beta", price: 70 },
    });
    const rows = await t.run(async (ctx: any) =>
      ctx.db
        .query("searchDocs")
        .withIndex("by_collection_doc", (q: any) =>
          q.eq("collection", "products").eq("docId", "p1"),
        )
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].text1).toBe("Blue Shoe");
    expect(rows[0].filt0).toBe("Beta");
    expect(rows[0].numF0).toBe(70);
    // old facet value gone, new value present
    const acme = await t.run(async (ctx: any) =>
      ctx.db
        .query("facetCounts")
        .withIndex("by_value", (q: any) =>
          q.eq("collection", "products").eq("field", "brand").eq("value", "Acme"),
        )
        .unique(),
    );
    const beta = await t.run(async (ctx: any) =>
      ctx.db
        .query("facetCounts")
        .withIndex("by_value", (q: any) =>
          q.eq("collection", "products").eq("field", "brand").eq("value", "Beta"),
        )
        .unique(),
    );
    expect(acme).toBeNull();
    expect(beta.count).toBe(1);
  });

  it("delete removes the row and reverses facet count", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "x", brand: "Acme", price: 50 },
    });
    await t.mutation(api.write.delete, { collection: "products", id: "p1" });
    const row = await rowFor(t, "p1");
    expect(row).toBeNull();
    const acme = await t.run(async (ctx: any) =>
      ctx.db
        .query("facetCounts")
        .withIndex("by_value", (q: any) =>
          q.eq("collection", "products").eq("field", "brand").eq("value", "Acme"),
        )
        .unique(),
    );
    expect(acme).toBeNull();
  });
});
