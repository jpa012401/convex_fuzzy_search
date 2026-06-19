import type { MutationCtx, QueryCtx } from "./_generated/server";

// Chunked inverted filter index. Mirrors facetPostings (fill-based) for string
// equality, and adds value-bucketed numeric postings (Task 2) for range scans.
export const FILTER_CHUNK_SIZE = 64;
export const NUMERIC_BUCKET_WIDTH = 256;

function insertSorted(arr: number[], x: number): number[] {
  if (arr.includes(x)) return arr;
  const out = [...arr, x];
  out.sort((a, b) => a - b);
  return out;
}

async function strTailBucket(ctx: QueryCtx, collection: string, field: string, value: string) {
  return await ctx.db
    .query("filterPostings")
    .withIndex("by_str", (q) => q.eq("collection", collection).eq("field", field).eq("strVal", value))
    .order("desc")
    .first();
}

export async function addStringPosting(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  field: string,
  value: string,
): Promise<void> {
  const tail = await strTailBucket(ctx, collection, field, value);
  if (!tail) {
    await ctx.db.insert("filterPostings", { collection, field, strVal: value, bucket: 0, docKeys: [docKey] });
    return;
  }
  if ((tail.docKeys ?? []).includes(docKey)) return; // caller fully removes before re-adding; guards same-tail dup only
  if ((tail.docKeys ?? []).length < FILTER_CHUNK_SIZE) {
    await ctx.db.patch(tail._id, { docKeys: insertSorted(tail.docKeys ?? [], docKey) });
  } else {
    await ctx.db.insert("filterPostings", { collection, field, strVal: value, bucket: tail.bucket + 1, docKeys: [docKey] });
  }
}

export async function removeStringPosting(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  field: string,
  value: string,
): Promise<void> {
  const rows = await ctx.db
    .query("filterPostings")
    .withIndex("by_str", (q) => q.eq("collection", collection).eq("field", field).eq("strVal", value))
    .collect();
  for (const row of rows) {
    if (!(row.docKeys ?? []).includes(docKey)) continue;
    const next = (row.docKeys ?? []).filter((k) => k !== docKey);
    if (next.length === 0) await ctx.db.delete(row._id);
    else await ctx.db.patch(row._id, { docKeys: next });
  }
}

export async function readStringPostingDocKeys(
  ctx: QueryCtx,
  collection: string,
  field: string,
  value: string,
  budget: number,
): Promise<{ docKeys: number[]; truncated: boolean }> {
  const seen = new Set<number>();
  let truncated = false;
  const rows = ctx.db
    .query("filterPostings")
    .withIndex("by_str", (q) => q.eq("collection", collection).eq("field", field).eq("strVal", value));
  for await (const row of rows) {
    for (const k of (row.docKeys ?? [])) {
      seen.add(k);
      if (seen.size > budget) { truncated = true; break; }
    }
    if (truncated) break;
  }
  const docKeys = [...seen].slice(0, budget);
  return { docKeys, truncated };
}

function numBucketOf(num: number): number {
  return Math.floor(num / NUMERIC_BUCKET_WIDTH);
}

async function numTailBucket(ctx: QueryCtx, collection: string, field: string, numBucket: number) {
  return await ctx.db
    .query("filterPostings")
    .withIndex("by_num", (q) => q.eq("collection", collection).eq("field", field).eq("numBucket", numBucket))
    .order("desc")
    .first();
}

export async function addNumericPosting(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  field: string,
  num: number,
): Promise<void> {
  const numBucket = numBucketOf(num);
  const tail = await numTailBucket(ctx, collection, field, numBucket);
  const entry = { docKey, num };
  if (!tail) {
    await ctx.db.insert("filterPostings", { collection, field, numBucket, bucket: 0, entries: [entry] });
    return;
  }
  if ((tail.entries ?? []).some((e) => e.docKey === docKey)) return; // caller fully removes before re-adding; guards same-tail dup only
  if ((tail.entries ?? []).length < FILTER_CHUNK_SIZE) {
    await ctx.db.patch(tail._id, { entries: [...(tail.entries ?? []), entry] });
  } else {
    await ctx.db.insert("filterPostings", { collection, field, numBucket, bucket: tail.bucket + 1, entries: [entry] });
  }
}

export async function removeNumericPosting(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  field: string,
  num: number,
): Promise<void> {
  const numBucket = numBucketOf(num);
  const rows = await ctx.db
    .query("filterPostings")
    .withIndex("by_num", (q) => q.eq("collection", collection).eq("field", field).eq("numBucket", numBucket))
    .collect();
  for (const row of rows) {
    const entries = row.entries ?? [];
    if (!entries.some((e) => e.docKey === docKey)) continue;
    const next = entries.filter((e) => e.docKey !== docKey);
    if (next.length === 0) await ctx.db.delete(row._id);
    else await ctx.db.patch(row._id, { entries: next });
  }
}

export async function readNumericRangeDocKeys(
  ctx: QueryCtx,
  collection: string,
  field: string,
  lo: number,
  hi: number,
  budget: number,
): Promise<{ docKeys: number[]; truncated: boolean }> {
  const loB = Number.isFinite(lo) ? numBucketOf(lo) : Number.NEGATIVE_INFINITY;
  const hiB = Number.isFinite(hi) ? numBucketOf(hi) : Number.POSITIVE_INFINITY;
  const seen = new Set<number>();
  let truncated = false;
  const q = ctx.db
    .query("filterPostings")
    .withIndex("by_num", (qb) => {
      let b = qb.eq("collection", collection).eq("field", field);
      if (Number.isFinite(loB)) b = b.gte("numBucket", loB as number);
      if (Number.isFinite(hiB)) b = b.lte("numBucket", hiB as number);
      return b;
    });
  for await (const row of q) {
    for (const e of row.entries ?? []) {
      if (e.num < lo || e.num > hi) continue; // edge-bucket value filter
      seen.add(e.docKey);
      if (seen.size > budget) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return { docKeys: [...seen].slice(0, budget), truncated };
}
