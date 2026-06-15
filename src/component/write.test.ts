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

async function postingsFor(t: any, docId: string) {
  return await t.run(async (ctx: any) =>
    ctx.db
      .query("postings")
      .withIndex("by_collection_doc", (q: any) =>
        q.eq("collection", "products").eq("docId", docId),
      )
      .collect(),
  );
}

describe("write path", () => {
  it("upsert tokenizes searchFields into postings and stores projection", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "running shoe", price: 50, secret: "x" },
    });
    const postings = await postingsFor(t, "p1");
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
    const terms = (await postingsFor(t, "p1")).map((p: any) => p.term).sort();
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
    expect(await postingsFor(t, "p1")).toEqual([]);
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
    // whole doc stored (not corrupted): title comes back intact and is highlightable
    expect(r.hits[0].document).toEqual({ title: "hello world" });
    expect(r.hits[0].highlight.title).toBeDefined();
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
    // ...but produces zero postings, so it can never match a text query.
    expect(await postingsFor(t, "p1")).toEqual([]);
  });
});
