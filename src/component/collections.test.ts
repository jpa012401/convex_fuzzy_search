import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

describe("collections", () => {
  it("creates and reads a collection", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name", "description"],
    });
    const c = await t.query(api.collections.getCollection, { name: "products" });
    expect(c).toMatchObject({
      name: "products",
      searchFields: ["name", "description"],
      storedFields: "all",
    });
  });

  it("rejects duplicate collection names", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name"],
    });
    await expect(
      t.mutation(api.collections.createCollection, {
        name: "products",
        searchFields: ["name"],
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("getCollection returns null for unknown name", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    expect(
      await t.query(api.collections.getCollection, { name: "nope" }),
    ).toBeNull();
  });

  it("deleteCollection removes the collection, its documents, posting chunks, terms, and trigrams", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name"],
      facetFields: ["name"],
      filterFields: [{ field: "name", type: "string" as const }],
    });
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe" },
    });
    await t.mutation(api.collections.deleteCollection, { name: "products" });

    expect(
      await t.query(api.collections.getCollection, { name: "products" }),
    ).toBeNull();
    const leftover = await t.run(async (ctx) => ({
      docs: await ctx.db
        .query("documents")
        .withIndex("by_collection_doc", (q) => q.eq("collection", "products"))
        .collect(),
      docTerms: await ctx.db
        .query("docTerms")
        .withIndex("by_collection_docKey", (q) => q.eq("collection", "products"))
        .collect(),
      postingChunks: await ctx.db
        .query("postingChunks")
        .withIndex("by_collection_term", (q) => q.eq("collection", "products"))
        .collect(),
      terms: await ctx.db
        .query("terms")
        .withIndex("by_collection_term", (q) => q.eq("collection", "products"))
        .collect(),
      trigrams: await ctx.db
        .query("trigrams")
        .withIndex("by_collection_term", (q) => q.eq("collection", "products"))
        .collect(),
      facetPostings: await ctx.db
        .query("facetPostings")
        .withIndex("by_collection_field_value", (q) => q.eq("collection", "products"))
        .collect(),
      filterPostingsStr: await ctx.db
        .query("filterPostings")
        .withIndex("by_str", (q) => q.eq("collection", "products"))
        .collect(),
      filterPostingsNum: await ctx.db
        .query("filterPostings")
        .withIndex("by_num", (q) => q.eq("collection", "products"))
        .collect(),
    }));
    expect(leftover.docs).toEqual([]);
    expect(leftover.docTerms).toEqual([]);
    expect(leftover.postingChunks).toEqual([]);
    expect(leftover.terms).toEqual([]);
    expect(leftover.trigrams).toEqual([]);
    expect(leftover.facetPostings).toEqual([]);
    expect(leftover.filterPostingsStr).toEqual([]);
    expect(leftover.filterPostingsNum).toEqual([]);
  });

  it("continues large collection cleanup in bounded internal batches before allowing recreate", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name"],
    });
    await t.mutation(api.write.upsertMany, {
      collection: "products",
      docs: Array.from({ length: 30 }, (_, i) => ({
        id: `p${String(i).padStart(2, "0")}`,
        doc: { name: `shared searchable product ${i}` },
      })),
    });

    await t.run(async (ctx) => {
      const collection = await ctx.db
        .query("collections")
        .withIndex("by_name", (q) => q.eq("name", "products"))
        .unique();
      if (!collection) throw new Error("missing collection");
      await ctx.db.delete(collection._id);
    });
    await expect(
      t.mutation(api.collections.createCollection, {
        name: "products",
        searchFields: ["name"],
      }),
    ).rejects.toThrow(/deletion in progress/);

    for (let i = 0; i < 200; i++) {
      const result = await t.mutation(internal.collections.cleanupCollectionBatch, {
        name: "products",
        sortSpecs: [],
        batchSize: 5,
        scheduleNext: false,
      });
      if (result.done) break;
      if (i === 199) throw new Error("cleanup did not finish");
    }

    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name"],
    });
    const recreated = await t.query(api.collections.getCollection, { name: "products" });
    expect(recreated).toMatchObject({ name: "products" });
  });
});

describe("storedFields 'derived'", () => {
  it("accepts storedFields 'derived' and stores it", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "p",
      searchFields: ["name"],
      storedFields: "derived",
      filterFields: [{ field: "brand", type: "string" }],
    });
    const c = await t.query(api.collections.getCollection, { name: "p" });
    expect(c?.storedFields).toBe("derived");
  });

  it("'derived' skips the explicit-projection consistency check", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    // With an EXPLICIT array projection that omits a filterField, createCollection
    // throws. With "derived", the same shape is accepted (projection is computed,
    // not hand-specified).
    await expect(
      t.mutation(api.collections.createCollection, {
        name: "explicit",
        searchFields: ["name"],
        storedFields: ["name"], // omits "brand" -> must throw
        filterFields: [{ field: "brand", type: "string" }],
      }),
    ).rejects.toThrow(/storedFields/);
    // Same config but "derived" -> accepted.
    await t.mutation(api.collections.createCollection, {
      name: "derived",
      searchFields: ["name"],
      storedFields: "derived",
      filterFields: [{ field: "brand", type: "string" }],
    });
    const c = await t.query(api.collections.getCollection, { name: "derived" });
    expect(c?.storedFields).toBe("derived");
  });
});

describe("numeric-only filterField deletion guard", () => {
  it("detects index rows for a numeric-only collection and blocks re-creation", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "listings",
      searchFields: ["title"],
      storedFields: "all",
      filterFields: [{ field: "price", type: "number" as const }],
    });
    await t.mutation(api.write.upsert, {
      collection: "listings",
      id: "l1",
      doc: { title: "Laptop", price: 999 },
    });

    // Simulate deletion-in-progress: remove the collections row but leave index rows
    await t.run(async (ctx) => {
      const collection = await ctx.db
        .query("collections")
        .withIndex("by_name", (q) => q.eq("name", "listings"))
        .unique();
      if (!collection) throw new Error("missing collection");
      await ctx.db.delete(collection._id);
    });

    // With only numeric filterPostings rows present, blockIfDeletionInProgress must throw
    await expect(
      t.mutation(api.collections.createCollection, {
        name: "listings",
        searchFields: ["title"],
      }),
    ).rejects.toThrow(/deletion in progress/);
  });
});

describe("filter/facet field config", () => {
  it("stores filterFields and facetFields", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
      ],
      facetFields: ["brand"],
    });
    const c = await t.query(api.collections.getCollection, { name: "products" });
    expect(c).toMatchObject({
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
      ],
      facetFields: ["brand"],
    });
  });

  it("rejects filter/facet fields not covered by a storedFields projection", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await expect(
      t.mutation(api.collections.createCollection, {
        name: "products",
        searchFields: ["name"],
        storedFields: ["name"],
        filterFields: [{ field: "brand", type: "string" }],
      }),
    ).rejects.toThrow(/storedFields/);
    await expect(
      t.mutation(api.collections.createCollection, {
        name: "p2",
        searchFields: ["name"],
        storedFields: ["name"],
        facetFields: ["brand"],
      }),
    ).rejects.toThrow(/storedFields/);
  });
});
