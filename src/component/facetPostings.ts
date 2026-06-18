import type { MutationCtx, QueryCtx } from "./_generated/server";

// Fill-based inverted facet index: (field, value) -> sorted docKeys, packed into
// buckets of FACET_CHUNK_SIZE. A docKey appends to the current tail bucket
// (highest `bucket`); a new bucket opens only when the tail is full. Removal
// deletes the docKey from whichever bucket holds it; an emptied bucket is
// deleted. No rebalancing — density is a write-time invariant, not maintained.
export const FACET_CHUNK_SIZE = 64;

type Facet = { field: string; value: string };

async function tailBucket(
  ctx: QueryCtx,
  collection: string,
  field: string,
  value: string,
) {
  return await ctx.db
    .query("facetPostings")
    .withIndex("by_collection_field_value_bucket", (q) =>
      q.eq("collection", collection).eq("field", field).eq("value", value),
    )
    .order("desc")
    .first();
}

function insertSorted(arr: number[], x: number): number[] {
  if (arr.includes(x)) return arr;
  const out = [...arr, x];
  out.sort((a, b) => a - b);
  return out;
}

export async function addFacetPostings(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  facets: Facet[],
): Promise<void> {
  for (const { field, value } of facets) {
    const tail = await tailBucket(ctx, collection, field, value);
    if (!tail) {
      await ctx.db.insert("facetPostings", { collection, field, value, bucket: 0, docKeys: [docKey] });
      continue;
    }
    if (tail.docKeys.includes(docKey)) continue; // already present somewhere is checked per-bucket; see remove note
    if (tail.docKeys.length < FACET_CHUNK_SIZE) {
      await ctx.db.patch(tail._id, { docKeys: insertSorted(tail.docKeys, docKey) });
    } else {
      await ctx.db.insert("facetPostings", { collection, field, value, bucket: tail.bucket + 1, docKeys: [docKey] });
    }
  }
}

export async function removeFacetPostings(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  facets: Facet[],
): Promise<void> {
  for (const { field, value } of facets) {
    const rows = await ctx.db
      .query("facetPostings")
      .withIndex("by_collection_field_value", (q) =>
        q.eq("collection", collection).eq("field", field).eq("value", value),
      )
      .collect();
    for (const row of rows) {
      if (!row.docKeys.includes(docKey)) continue;
      const next = row.docKeys.filter((k) => k !== docKey);
      if (next.length === 0) await ctx.db.delete(row._id);
      else await ctx.db.patch(row._id, { docKeys: next });
    }
  }
}

export async function readFacetPostingDocKeys(
  ctx: QueryCtx,
  collection: string,
  field: string,
  value: string,
): Promise<number[]> {
  const seen = new Set<number>();
  const rows = await ctx.db
    .query("facetPostings")
    .withIndex("by_collection_field_value", (q) =>
      q.eq("collection", collection).eq("field", field).eq("value", value),
    )
    .collect();
  for (const row of rows) for (const k of row.docKeys) seen.add(k);
  return [...seen];
}
