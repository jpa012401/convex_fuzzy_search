import type { MutationCtx, QueryCtx } from "./_generated/server";

// TODO: Current chunking uses fixed docKey ranges (0-63 → bucket 0, 64-127 → bucket 1, etc.)
// This means rare terms with few postings create sparse chunks (e.g., 2 entries in a 64-slot bucket).
// Observed: 18,162 chunks for 5,120 docs (~3.5 chunks/doc) due to many unique/rare terms.
// Future optimizations to consider:
// - Fill-based chunking (trade-off: write contention with OCC)
// - Adaptive chunk sizes for rare vs common terms
// - Lazy background compaction of sparse chunks
// - Skip chunking for terms below a posting threshold
export const POSTING_CHUNK_SIZE = 64;

export type DocTerm = {
  term: string;
  field: string;
  tf: number;
};

export type PostingEntry = {
  docKey: number;
  field: string;
  tf: number;
};

export type TermPosting = PostingEntry & {
  term: string;
};

function bucketForDocKey(docKey: number): number {
  return Math.floor(docKey / POSTING_CHUNK_SIZE);
}

function sortEntries(entries: PostingEntry[]): PostingEntry[] {
  return [...entries].sort((a, b) => {
    if (a.docKey !== b.docKey) return a.docKey - b.docKey;
    return a.field.localeCompare(b.field);
  });
}

async function loadPostingChunk(
  ctx: QueryCtx,
  collection: string,
  term: string,
  bucket: number,
) {
  return await ctx.db
    .query("postingChunks")
    .withIndex("by_collection_term_bucket", (q) =>
      q.eq("collection", collection).eq("term", term).eq("bucket", bucket),
    )
    .unique();
}

export async function upsertDocTerms(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  terms: DocTerm[],
): Promise<void> {
  const existing = await ctx.db
    .query("docTerms")
    .withIndex("by_collection_docKey", (q) =>
      q.eq("collection", collection).eq("docKey", docKey),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, { terms });
    return;
  }

  await ctx.db.insert("docTerms", { collection, docKey, terms });
}

export async function loadDocTerms(
  ctx: QueryCtx,
  collection: string,
  docKey: number,
): Promise<DocTerm[]> {
  const row = await ctx.db
    .query("docTerms")
    .withIndex("by_collection_docKey", (q) =>
      q.eq("collection", collection).eq("docKey", docKey),
    )
    .unique();
  return row?.terms ?? [];
}

export async function deleteDocTerms(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
): Promise<void> {
  const row = await ctx.db
    .query("docTerms")
    .withIndex("by_collection_docKey", (q) =>
      q.eq("collection", collection).eq("docKey", docKey),
    )
    .unique();
  if (row) await ctx.db.delete(row._id);
}

export async function addPostingEntries(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  terms: DocTerm[],
): Promise<void> {
  for (const { term, field, tf } of terms) {
    const bucket = bucketForDocKey(docKey);
    const chunk = await loadPostingChunk(ctx, collection, term, bucket);
    const entry = { docKey, field, tf };
    if (!chunk) {
      await ctx.db.insert("postingChunks", {
        collection,
        term,
        bucket,
        entries: [entry],
      });
      continue;
    }

    const entries = chunk.entries.filter(
      (item) => item.docKey !== docKey || item.field !== field,
    );
    entries.push(entry);
    await ctx.db.patch(chunk._id, { entries: sortEntries(entries) });
  }
}

export async function removePostingEntries(
  ctx: MutationCtx,
  collection: string,
  docKey: number,
  terms: DocTerm[],
): Promise<void> {
  for (const { term, field } of terms) {
    const bucket = bucketForDocKey(docKey);
    const chunk = await loadPostingChunk(ctx, collection, term, bucket);
    if (!chunk) continue;

    const entries = chunk.entries.filter(
      (item) => item.docKey !== docKey || item.field !== field,
    );
    if (entries.length === 0) {
      await ctx.db.delete(chunk._id);
    } else {
      await ctx.db.patch(chunk._id, { entries });
    }
  }
}

export async function* readTermPostings(
  ctx: QueryCtx,
  collection: string,
  term: string,
): AsyncGenerator<TermPosting> {
  const chunks = ctx.db
    .query("postingChunks")
    .withIndex("by_collection_term", (q) =>
      q.eq("collection", collection).eq("term", term),
    );

  for await (const chunk of chunks) {
    for (const entry of chunk.entries) {
      yield { term, ...entry };
    }
  }
}
