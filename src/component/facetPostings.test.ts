/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import {
  FACET_CHUNK_SIZE,
  addFacetPostings,
  removeFacetPostings,
  readFacetPostingDocKeys,
} from "./facetPostings";

const modules = import.meta.glob("./**/*.ts");

describe("facetPostings (fill-based)", () => {
  it("fills the tail bucket before opening a new one", async () => {
    const t = convexTest(schema, modules);
    const N = FACET_CHUNK_SIZE + 5; // forces a 2nd bucket
    await t.run(async (ctx) => {
      for (let k = 0; k < N; k++) {
        await addFacetPostings(ctx, "c", k, [{ field: "category", value: "X" }]);
      }
    });
    const { buckets, all } = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("facetPostings")
        .withIndex("by_collection_field_value", (q) =>
          q.eq("collection", "c").eq("field", "category").eq("value", "X"),
        )
        .collect();
      const all = await readFacetPostingDocKeys(ctx, "c", "category", "X");
      return { buckets: rows.map((r) => r.docKeys.length).sort((a, b) => b - a), all: [...all].sort((a, b) => a - b) };
    });
    expect(buckets).toEqual([FACET_CHUNK_SIZE, 5]); // first full, tail holds remainder
    expect(all.length).toBe(N);
    expect(all).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it("dedups a repeated docKey", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await addFacetPostings(ctx, "c", 7, [{ field: "f", value: "v" }]);
      await addFacetPostings(ctx, "c", 7, [{ field: "f", value: "v" }]);
    });
    const all = await t.run((ctx) => readFacetPostingDocKeys(ctx, "c", "f", "v"));
    expect([...all]).toEqual([7]);
  });

  it("removes a docKey and deletes an emptied bucket", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await addFacetPostings(ctx, "c", 1, [{ field: "f", value: "v" }]);
      await removeFacetPostings(ctx, "c", 1, [{ field: "f", value: "v" }]);
    });
    const { all, rowCount } = await t.run(async (ctx) => {
      const all = await readFacetPostingDocKeys(ctx, "c", "f", "v");
      const rows = await ctx.db
        .query("facetPostings")
        .withIndex("by_collection_field_value", (q) => q.eq("collection", "c").eq("field", "f").eq("value", "v"))
        .collect();
      return { all: [...all], rowCount: rows.length };
    });
    expect(all).toEqual([]);
    expect(rowCount).toBe(0);
  });
});
