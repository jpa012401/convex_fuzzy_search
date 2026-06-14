import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

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

  it("deleteCollection removes the collection, its documents, postings, terms, and trigrams", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name"],
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
      postings: await ctx.db
        .query("postings")
        .withIndex("by_collection_doc", (q) => q.eq("collection", "products"))
        .collect(),
      terms: await ctx.db
        .query("terms")
        .withIndex("by_collection_term", (q) => q.eq("collection", "products"))
        .collect(),
      trigrams: await ctx.db
        .query("trigrams")
        .withIndex("by_collection_term", (q) => q.eq("collection", "products"))
        .collect(),
    }));
    expect(leftover.docs).toEqual([]);
    expect(leftover.postings).toEqual([]);
    expect(leftover.terms).toEqual([]);
    expect(leftover.trigrams).toEqual([]);
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
