import { DirectAggregate } from "@convex-dev/aggregate";
import { components } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { SortKey } from "./ranking";
import { numField } from "./ranking";

// Second aggregate instance (alongside docCount). One ordered space per
// (collection, declared spec); composite numeric key; docId as the unique id
// so ties break by docId — matching the in-memory comparator's tie-break.
const sortAgg = new DirectAggregate<{
  Namespace: [string, string];
  Key: number[];
  Id: string;
}>(components.sortIndex);

// Canonical identity of a sort spec: "rating:desc,price:asc".
export function canonicalSpecId(sortBy: SortKey[]): string {
  return sortBy.map((k) => `${k.field}:${k.order}`).join(",");
}

// Encode a doc's values for a spec into a composite key. Ascending lexicographic
// order on this key reproduces the requested multi-key order (desc -> negate).
export function encodeKey(
  stored: Record<string, unknown>,
  spec: SortKey[],
): number[] {
  return spec.map((k) =>
    k.order === "desc" ? -numField(stored, k.field) : numField(stored, k.field),
  );
}

// The declared spec whose canonical id equals the query's sortBy, else null.
export function specMatches(
  sortBy: SortKey[] | undefined,
  sortSpecs: SortKey[][],
): SortKey[] | null {
  if (!sortBy || sortBy.length === 0) return null;
  const id = canonicalSpecId(sortBy);
  for (const spec of sortSpecs) {
    if (canonicalSpecId(spec) === id) return spec;
  }
  return null;
}

// Structured tuple namespace [collection, specId] — the aggregate orders array
// namespaces element-wise, so two distinct (collection, spec) pairs can never
// alias (a string-join separator could, since names may contain any character).
function ns(collection: string, specId: string): [string, string] {
  return [collection, specId];
}

export async function addSortEntry(
  ctx: MutationCtx,
  collection: string,
  spec: SortKey[],
  stored: Record<string, unknown>,
  docId: string,
) {
  await sortAgg.insertIfDoesNotExist(ctx, {
    namespace: ns(collection, canonicalSpecId(spec)),
    key: encodeKey(stored, spec),
    id: docId,
  });
}

export async function removeSortEntry(
  ctx: MutationCtx,
  collection: string,
  spec: SortKey[],
  stored: Record<string, unknown>,
  docId: string,
) {
  await sortAgg.deleteIfExists(ctx, {
    namespace: ns(collection, canonicalSpecId(spec)),
    key: encodeKey(stored, spec),
    id: docId,
  });
}

// docIds for a page [offset, offset+limit) in the spec's order. Reads the page
// in ONE batched atBatch call instead of `limit` sequential at() lookups.
export async function pageSortedDocIds(
  ctx: QueryCtx,
  collection: string,
  specId: string,
  offset: number,
  limit: number,
): Promise<string[]> {
  const namespace = ns(collection, specId);
  const total = await sortAgg.count(ctx, { namespace });
  const offsets: number[] = [];
  for (let i = 0; i < limit && offset + i < total; i++) offsets.push(offset + i);
  if (offsets.length === 0) return [];
  const items = await sortAgg.atBatch(
    ctx,
    offsets.map((o) => ({ offset: o, namespace })),
  );
  return items.map((it) => it.id);
}

// First `limit` docIds of a spec namespace in base order, read as a SINGLE
// batched range scan (aggregate `iter` with internal paging) — not `limit`
// separate `at()` calls. Used to retrieve a re-rank window cheaply.
export async function pageSortedDocIdsRange(
  ctx: QueryCtx,
  collection: string,
  specId: string,
  limit: number,
): Promise<string[]> {
  const namespace = ns(collection, specId);
  const ids: string[] = [];
  for await (const item of sortAgg.iter(ctx, { namespace, order: "asc", pageSize: 200 })) {
    ids.push(item.id);
    if (ids.length >= limit) break;
  }
  return ids;
}

// Number of indexed entries for one spec (validation: should equal out_of).
export async function sortSpecCount(
  ctx: QueryCtx,
  collection: string,
  specId: string,
): Promise<number> {
  return await sortAgg.count(ctx, { namespace: ns(collection, specId) });
}

// Empty every declared spec's namespace for a collection (deleteCollection).
export async function clearCollectionSort(
  ctx: MutationCtx,
  collection: string,
  sortSpecs: SortKey[][],
) {
  for (const spec of sortSpecs) {
    await sortAgg.clear(ctx, { namespace: ns(collection, canonicalSpecId(spec)) });
  }
}
