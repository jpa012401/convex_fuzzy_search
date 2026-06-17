import { describe, expect, it } from "vitest";
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
    storedFields: ["name", "description"],
  });
  return t;
}

describe("posting compression", () => {
  it("stores document terms and chunked term postings", async () => {
    const t = await setup();

    await t.mutation(api.write.upsertMany, {
      collection: "products",
      docs: Array.from({ length: 12 }, (_, i) => ({
        id: `p${i}`,
        doc: { name: "shared token", description: `unique${i}` },
      })),
    });

    const rows = await t.run(async (ctx) => {
      const docTerms = await ctx.db
        .query("docTerms")
        .withIndex("by_collection_docKey", (q) =>
          q.eq("collection", "products"),
        )
        .collect();
      const sharedChunks = await ctx.db
        .query("postingChunks")
        .withIndex("by_collection_term", (q) =>
          q.eq("collection", "products").eq("term", "shared"),
        )
        .collect();

      return { docTerms, sharedChunks };
    });

    expect(rows.docTerms).toHaveLength(12);
    expect(rows.sharedChunks.length).toBeGreaterThan(0);
    expect(rows.sharedChunks.length).toBeLessThan(12);
  });

  it("removes stale chunk entries when a document is replaced or deleted", async () => {
    const t = await setup();

    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "red shoe", description: "running shoe" },
    });
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "blue hat", description: "" },
    });

    const stale = await t.query(api.search.search, {
      collection: "products",
      q: "red",
    });
    const fresh = await t.query(api.search.search, {
      collection: "products",
      q: "blue",
    });
    expect(stale.found).toBe(0);
    expect(fresh.hits.map((hit) => hit.id)).toEqual(["p1"]);

    await t.mutation(api.write.delete, { collection: "products", id: "p1" });

    const afterDelete = await t.query(api.search.search, {
      collection: "products",
      q: "blue",
    });
    const remainingDocTerms = await t.run(async (ctx) =>
      await ctx.db
        .query("docTerms")
        .withIndex("by_collection_docKey", (q) =>
          q.eq("collection", "products"),
        )
        .collect(),
    );

    expect(afterDelete.found).toBe(0);
    expect(remainingDocTerms).toEqual([]);
  });
});
