import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { applyTermDiff, suggestTerms } from "./termDict";

const modules = import.meta.glob("./**/*.ts");

describe("termDict", () => {
  it("suggestTerms returns correction for typo", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");

    // Seed terms: running, runner, ringtone
    await t.run(async (ctx) => {
      await applyTermDiff(ctx as any, "c", new Set(), new Set(["running", "runner", "ringtone"]));
    });

    // "runing" (1 char typo) should suggest "running"
    const suggestions = await t.run(async (ctx) => {
      return suggestTerms(ctx as any, "c", "runing");
    });
    expect(suggestions).toContain("running");
    expect(suggestions[0]).toBe("running");

    // Completely unrelated token returns []
    const none = await t.run(async (ctx) => suggestTerms(ctx as any, "c", "xyz"));
    expect(none).toEqual([]);

    // Short token (<=3 chars) returns [] — typoBudget(3) = 0
    const short = await t.run(async (ctx) => suggestTerms(ctx as any, "c", "ab"));
    expect(short).toEqual([]);
  });

  it("write-maintenance: applyTermDiff ref-counts terms correctly", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");

    // Set up a collection
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: {
        name: "products",
        searchFields: ["name", "description"],
        storedFields: ["name"],
      },
    });

    // Upsert doc1 with "running shoe"
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "d1",
      doc: { name: "running shoe", description: "" },
    });

    // terms has "running" + "shoe" with docCount 1 each
    const runningAfterD1 = await t.run(async (ctx) =>
      ctx.db
        .query("terms")
        .withIndex("by_collection_term", (q) =>
          q.eq("collection", "products").eq("term", "running"),
        )
        .unique(),
    );
    expect(runningAfterD1?.docCount).toBe(1);

    const shoeAfterD1 = await t.run(async (ctx) =>
      ctx.db
        .query("terms")
        .withIndex("by_collection_term", (q) =>
          q.eq("collection", "products").eq("term", "shoe"),
        )
        .unique(),
    );
    expect(shoeAfterD1?.docCount).toBe(1);

    // Upsert doc2 also containing "running"
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "d2",
      doc: { name: "running track", description: "" },
    });

    // running docCount = 2
    const runningAfterD2 = await t.run(async (ctx) =>
      ctx.db
        .query("terms")
        .withIndex("by_collection_term", (q) =>
          q.eq("collection", "products").eq("term", "running"),
        )
        .unique(),
    );
    expect(runningAfterD2?.docCount).toBe(2);

    // Delete doc1 ("running shoe")
    await t.mutation(api.write.deleteDoc, { collection: "products", id: "d1" });

    // running docCount back to 1
    const runningAfterDelete = await t.run(async (ctx) =>
      ctx.db
        .query("terms")
        .withIndex("by_collection_term", (q) =>
          q.eq("collection", "products").eq("term", "running"),
        )
        .unique(),
    );
    expect(runningAfterDelete?.docCount).toBe(1);

    // shoe removed (docCount went to 0 -> row deleted)
    const shoeAfterDelete = await t.run(async (ctx) =>
      ctx.db
        .query("terms")
        .withIndex("by_collection_term", (q) =>
          q.eq("collection", "products").eq("term", "shoe"),
        )
        .unique(),
    );
    expect(shoeAfterDelete).toBeNull();

    // shoe's trigrams also gone
    const shoeTrigramsAfterDelete = await t.run(async (ctx) =>
      ctx.db
        .query("trigrams")
        .withIndex("by_collection_term", (q) =>
          q.eq("collection", "products").eq("term", "shoe"),
        )
        .collect(),
    );
    expect(shoeTrigramsAfterDelete).toHaveLength(0);
  });
});
