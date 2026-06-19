/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import {
  FILTER_CHUNK_SIZE,
  addStringPosting,
  removeStringPosting,
  readStringPostingDocKeys,
} from "./filterPostings";

const modules = import.meta.glob("./**/*.ts");

describe("filterPostings — string (fill-based)", () => {
  it("fills the tail bucket before opening a new one", async () => {
    const t = convexTest(schema, modules);
    const N = FILTER_CHUNK_SIZE + 5;
    await t.run(async (ctx) => {
      for (let k = 0; k < N; k++) await addStringPosting(ctx, "c", k, "brand", "Aurora");
    });
    const { buckets, read } = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("filterPostings")
        .withIndex("by_str", (q) => q.eq("collection", "c").eq("field", "brand").eq("strVal", "Aurora"))
        .collect();
      const read = await readStringPostingDocKeys(ctx, "c", "brand", "Aurora", 10_000);
      return {
        buckets: rows.map((r) => r.docKeys.length).sort((a, b) => b - a),
        read: { docKeys: [...read.docKeys].sort((a, b) => a - b), truncated: read.truncated },
      };
    });
    expect(buckets).toEqual([FILTER_CHUNK_SIZE, 5]);
    expect(read.docKeys).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(read.truncated).toBe(false);
  });

  it("dedups a repeated docKey and removes/deletes an emptied bucket", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await addStringPosting(ctx, "c", 7, "f", "v");
      await addStringPosting(ctx, "c", 7, "f", "v");
      await removeStringPosting(ctx, "c", 7, "f", "v");
    });
    const { docKeys, rowCount } = await t.run(async (ctx) => {
      const r = await readStringPostingDocKeys(ctx, "c", "f", "v", 10_000);
      const rows = await ctx.db
        .query("filterPostings")
        .withIndex("by_str", (q) => q.eq("collection", "c").eq("field", "f").eq("strVal", "v"))
        .collect();
      return { docKeys: [...r.docKeys], rowCount: rows.length };
    });
    expect(docKeys).toEqual([]);
    expect(rowCount).toBe(0);
  });

  it("reports truncation when read exceeds budget", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let k = 0; k < 8; k++) await addStringPosting(ctx, "c", k, "f", "v");
    });
    const r = await t.run((ctx) => readStringPostingDocKeys(ctx, "c", "f", "v", 3));
    expect(r.docKeys.length).toBeLessThanOrEqual(3);
    expect(r.truncated).toBe(true);
  });
});
