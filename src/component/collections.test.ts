import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

describe("collections", () => {
  it("creates and reads a collection", async () => {
    const t = convexTest(schema, modules);
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
    expect(
      await t.query(api.collections.getCollection, { name: "nope" }),
    ).toBeNull();
  });

  it("deleteCollection removes the collection, its documents, postings, terms, and trigrams", async () => {
    const t = convexTest(schema, modules);
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
