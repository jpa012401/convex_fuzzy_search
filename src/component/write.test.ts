import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "products",
    searchFields: ["name", "description"],
    storedFields: ["name", "price"],
  });
  return t;
}

async function docTermsFor(t: any, docId: string) {
  return await t.run(async (ctx: any) => {
    const doc = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q: any) =>
        q.eq("collection", "products").eq("docId", docId),
      )
      .unique();
    if (!doc) return [];
    const row = await ctx.db
      .query("docTerms")
      .withIndex("by_collection_docKey", (q: any) =>
        q.eq("collection", "products").eq("docKey", doc.docKey),
      )
      .unique();
    return row?.terms ?? [];
  });
}

describe("write path", () => {
  it("upsert tokenizes searchFields into postings and stores projection", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "running shoe", price: 50, secret: "x" },
    });
    const postings = await docTermsFor(t, "p1");
    const terms = postings.map((p: any) => p.term).sort();
    expect(terms).toEqual(["red", "running", "shoe", "shoe"].sort());
    const docs = await t.run(async (ctx: any) =>
      ctx.db
        .query("documents")
        .withIndex("by_collection_doc", (q: any) =>
          q.eq("collection", "products").eq("docId", "p1"),
        )
        .unique(),
    );
    expect(docs.stored).toEqual({ name: "Red Shoe", price: 50 });
  });

  it("re-upsert replaces postings with no orphans", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "running shoe", price: 50 },
    });
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Blue Hat", description: "", price: 10 },
    });
    const terms = (await docTermsFor(t, "p1")).map((p: any) => p.term).sort();
    expect(terms).toEqual(["blue", "hat"]);
  });

  it("delete removes document and all its postings", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "running shoe", price: 50 },
    });
    await t.mutation(api.write.delete, { collection: "products", id: "p1" });
    expect(await docTermsFor(t, "p1")).toEqual([]);
  });

  it("upsert on unknown collection throws CollectionNotFound", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await expect(
      t.mutation(api.write.upsert, { collection: "nope", id: "p1", doc: {} }),
    ).rejects.toThrow(/CollectionNotFound/);
  });

  it("derived storedFields stores the document (no char-by-char corruption)", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "d",
      searchFields: ["title"],
      storedFields: "derived",
    });
    await t.mutation(api.write.upsert, {
      collection: "d",
      id: "1",
      doc: { title: "hello world" },
    });
    const r = await t.query(api.search.search, { collection: "d", q: "hello" });
    expect(r.found).toBeGreaterThanOrEqual(1);
    // whole doc stored (not corrupted): the stored snapshot is the intact title field,
    // not a char-by-char-indexed blob, and it remains highlightable.
    const stored = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("documents")
        .withIndex("by_collection_doc", (q) => q.eq("collection", "d").eq("docId", "1"))
        .unique();
      return row?.stored as Record<string, unknown>;
    });
    expect(stored).toEqual({ title: "hello world" });
    expect(r.hits[0].highlight.title).toBeDefined();
  });

  it("derived storedFields persists only index-relevant fields", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "books",
      searchFields: ["title"],
      storedFields: "derived",
      filterFields: [{ field: "year", type: "number" }],
    });
    await t.mutation(api.write.upsert, {
      collection: "books",
      id: "b1",
      doc: { title: "gatsby", year: 1925, blurb_html: "<h1>huge serving blob</h1>", isbn: "x" },
    });
    // Inspect the stored snapshot directly via t.run reading the documents table.
    const stored = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("documents")
        .withIndex("by_collection_doc", (q) => q.eq("collection", "books").eq("docId", "b1"))
        .unique();
      return row?.stored as Record<string, unknown>;
    });
    // title (searchField) and year (filterField) kept; blurb_html / isbn dropped.
    expect(stored).toEqual({ title: "gatsby", year: 1925 });
  });

  it("all storedFields still persists the whole doc", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "all1",
      searchFields: ["title"],
      storedFields: "all",
    });
    await t.mutation(api.write.upsert, {
      collection: "all1",
      id: "x",
      doc: { title: "t", extra: "kept" },
    });
    const stored = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("documents")
        .withIndex("by_collection_doc", (q) => q.eq("collection", "all1").eq("docId", "x"))
        .unique();
      return row?.stored as Record<string, unknown>;
    });
    expect(stored).toEqual({ title: "t", extra: "kept" });
  });

  it("derived projection keeps rank-only fields (geo lat/lng) for query-time re-rank", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");
    await t.mutation(api.collections.createCollection, {
      name: "geo",
      searchFields: ["title"],
      storedFields: "derived",
      sortSpecs: [[{ field: "rank", order: "asc" }]],
      rankProfiles: {
        near: {
          base: "rank:asc",
          terms: [
            { id: "g", type: "geoDistance", weight: 1, latField: "lat", lngField: "lng", maxKm: 10 },
          ],
        },
      },
    });
    await t.mutation(api.write.upsert, {
      collection: "geo",
      id: "p1",
      doc: { title: "shop", rank: 1, lat: 40.0, lng: -73.0, junk: "drop me" },
    });
    const stored = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("documents")
        .withIndex("by_collection_doc", (q) => q.eq("collection", "geo").eq("docId", "p1"))
        .unique();
      return row?.stored as Record<string, unknown>;
    });
    // lat/lng referenced only by the rankProfile -> kept; junk -> dropped; title+rank kept.
    expect(stored).toMatchObject({ title: "shop", rank: 1, lat: 40.0, lng: -73.0 });
    expect(stored.junk).toBeUndefined();
  });

  it("stores a doc with no indexable searchFields but makes it unmatchable", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      // no `name`/`description`; price is a number so it is not tokenized
      doc: { price: 50 },
    });
    // doc is stored (projection keeps `price`)...
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("documents")
        .withIndex("by_collection_doc", (q) =>
          q.eq("collection", "products").eq("docId", "p1"),
        )
        .unique(),
    );
    expect(stored?.stored).toEqual({ price: 50 });
    // ...but produces zero indexed terms, so it can never match a text query.
    expect(await docTermsFor(t, "p1")).toEqual([]);
  });

  it("rejects oversized upsertMany batches", async () => {
    const t = await setup();
    await expect(
      t.mutation(api.write.upsertMany, {
        collection: "products",
        docs: Array.from({ length: 51 }, (_, i) => ({
          id: `p${i}`,
          doc: { name: `product ${i}`, price: i },
        })),
      }),
    ).rejects.toThrow(/at most 50/);
  });
});
