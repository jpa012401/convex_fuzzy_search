import { DirectAggregate } from "@convex-dev/aggregate";
import { components } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";

// One balanced-tree aggregate, namespaced by collection, keyed by docId.
// Gives O(log n) count and at(offset) — so out_of and browse pagination don't
// scan the documents table.
const docAgg = new DirectAggregate<{
  Namespace: string;
  Key: string;
  Id: string;
}>(components.docCount);

export async function addDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
) {
  await docAgg.insertIfDoesNotExist(ctx, {
    namespace: collection,
    key: docId,
    id: docId,
  });
}

export async function removeDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
) {
  await docAgg.deleteIfExists(ctx, {
    namespace: collection,
    key: docId,
    id: docId,
  });
}

export async function collectionCount(
  ctx: QueryCtx,
  collection: string,
): Promise<number> {
  return await docAgg.count(ctx, { namespace: collection });
}

// docIds for a page [offset, offset+limit), in key (docId) order. Reads the page
// in ONE batched atBatch call instead of `limit` sequential at() lookups.
export async function pageDocIds(
  ctx: QueryCtx,
  collection: string,
  offset: number,
  limit: number,
): Promise<string[]> {
  const total = await docAgg.count(ctx, { namespace: collection });
  const offsets: number[] = [];
  for (let i = 0; i < limit && offset + i < total; i++) offsets.push(offset + i);
  if (offsets.length === 0) return [];
  const items = await docAgg.atBatch(
    ctx,
    offsets.map((o) => ({ offset: o, namespace: collection })),
  );
  return items.map((it) => it.id);
}

// Empty a collection's namespace (used by deleteCollection — scalable clear).
export async function clearCollectionCount(
  ctx: MutationCtx,
  collection: string,
) {
  await docAgg.clear(ctx, { namespace: collection });
}

// Empty EVERY collection's namespace at once (used by the full component reset).
export async function clearAllCount(ctx: MutationCtx) {
  await docAgg.clearAll(ctx);
}
