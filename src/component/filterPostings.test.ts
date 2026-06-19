/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import {
  FILTER_CHUNK_SIZE,
  NUMERIC_BUCKET_WIDTH,
  addStringPosting,
  removeStringPosting,
  readStringPostingDocKeys,
  addNumericPosting,
  removeNumericPosting,
  readNumericRangeDocKeys,
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
        buckets: rows.map((r) => (r.docKeys ?? []).length).sort((a, b) => b - a),
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

describe("filterPostings — numeric (value-bucketed range)", () => {
  it("resolves an inclusive range across bucket boundaries", async () => {
    const t = convexTest(schema, modules);
    // values spanning 3 numeric buckets at W=256: 50, 110, 150, 300, 600
    const vals = [
      { k: 1, v: 50 },
      { k: 2, v: 110 },
      { k: 3, v: 150 },
      { k: 4, v: 300 },
      { k: 5, v: 600 },
    ];
    await t.run(async (ctx) => {
      for (const { k, v } of vals) await addNumericPosting(ctx, "c", k, "price", v);
    });
    const inRange = await t.run((ctx) => readNumericRangeDocKeys(ctx, "c", "price", 50, 150, true, true, 10_000));
    expect([...inRange.docKeys].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(inRange.truncated).toBe(false);

    const open = await t.run((ctx) =>
      readNumericRangeDocKeys(ctx, "c", "price", 100, Number.POSITIVE_INFINITY, true, true, 10_000),
    );
    expect([...open.docKeys].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
  });

  it("removes a docKey from its numeric bucket and deletes an emptied row", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await addNumericPosting(ctx, "c", 9, "price", 42);
      await removeNumericPosting(ctx, "c", 9, "price", 42);
    });
    const r = await t.run((ctx) => readNumericRangeDocKeys(ctx, "c", "price", 0, 1000, true, true, 10_000));
    expect([...r.docKeys]).toEqual([]);
  });

  it("excludes a doc priced exactly at lo when loInclusive=false", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await addNumericPosting(ctx, "c", 10, "price", 100); // exactly at boundary
      await addNumericPosting(ctx, "c", 11, "price", 101); // above boundary
    });
    // loInclusive=false means >100, so docKey 10 (price=100) must be excluded
    const r = await t.run((ctx) => readNumericRangeDocKeys(ctx, "c", "price", 100, Number.POSITIVE_INFINITY, false, true, 10_000));
    expect([...r.docKeys].sort((a, b) => a - b)).toEqual([11]);
  });

  it("uses NUMERIC_BUCKET_WIDTH to bucket values", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await addNumericPosting(ctx, "c", 1, "price", NUMERIC_BUCKET_WIDTH - 1); // bucket 0
      await addNumericPosting(ctx, "c", 2, "price", NUMERIC_BUCKET_WIDTH); // bucket 1
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("filterPostings")
        .withIndex("by_num", (q) => q.eq("collection", "c").eq("field", "price"))
        .collect(),
    );
    expect(rows.map((r) => r.numBucket).sort((a, b) => (a! - b!))).toEqual([0, 1]);
  });
});
