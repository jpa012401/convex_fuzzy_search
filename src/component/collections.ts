import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { clearCollectionCount } from "./counters";
import { clearCollectionFacets } from "./facetCounts";
import { canonicalSpecId, clearCollectionSort } from "./sortIndex";
import { clearCollectionTermsBatch } from "./termDict";
import type { Infer } from "convex/values";
import { collectionDocValidator, rankProfileValidator, rankTermValidator, sortSpecValidator } from "./schema";
import type { SortKey } from "./ranking";
import { assignSlots } from "./slotMap";

const DELETE_BATCH_SIZE = 25;
const DELETE_BATCHES_PER_PUBLIC_CALL = 64;

export async function loadCollection(ctx: QueryCtx, name: string) {
  return await ctx.db
    .query("collections")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

async function loadDeletion(ctx: QueryCtx, name: string) {
  return await ctx.db
    .query("deletions")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

export async function requireCollection(ctx: QueryCtx, name: string) {
  const c = await loadCollection(ctx, name);
  if (c === null) {
    throw new Error(`CollectionNotFound: "${name}"`);
  }
  return c;
}

async function hasCollectionIndexRows(ctx: QueryCtx, name: string): Promise<boolean> {
  const row = await ctx.db
    .query("searchDocs")
    .withIndex("by_collection_doc", (q) => q.eq("collection", name))
    .first();
  return !!row;
}

export async function blockIfDeletionInProgress(ctx: QueryCtx, name: string): Promise<void> {
  if ((await loadDeletion(ctx, name)) || (await hasCollectionIndexRows(ctx, name))) {
    throw new Error(`Collection "${name}" deletion in progress`);
  }
}

async function deleteCollectionRowsBatch(
  ctx: MutationCtx,
  name: string,
  batchSize: number,
): Promise<boolean> {
  const rows = await ctx.db
    .query("searchDocs")
    .withIndex("by_collection_doc", (q) => q.eq("collection", name))
    .take(batchSize);
  if (rows.length > 0) {
    for (const r of rows) await ctx.db.delete(r._id);
    return false;
  }
  // searchDocs is drained; drain the vocabulary dictionary (terms + trigrams).
  const dictDone = await clearCollectionTermsBatch(ctx, name, batchSize);
  return dictDone;
}

async function cleanupCollectionBatchInternal(
  ctx: MutationCtx,
  name: string,
  sortSpecs: SortKey[][],
  batchSize: number,
): Promise<{ done: boolean }> {
  const done = await deleteCollectionRowsBatch(ctx, name, batchSize);
  if (!done) return { done: false };

  await clearCollectionCount(ctx, name);
  await clearCollectionSort(ctx, name, sortSpecs);
  await clearCollectionFacets(ctx, name);
  const deletion = await loadDeletion(ctx, name);
  if (deletion) await ctx.db.delete(deletion._id);
  return { done: true };
}

export function validateCollectionConfig(args: {
  storedFields: "all" | "derived" | string[];
  searchFields: string[];
  filterFields?: { field: string; type: "string" | "number" }[];
  facetFields?: string[];
  sortSpecs?: { field: string; order: "asc" | "desc" }[][];
  rankProfiles?: Record<string, { base: string; terms: Infer<typeof rankTermValidator>[] }>;
}): void {
  const storedFields = args.storedFields;
  // "derived" is treated like "all": the explicit-projection consistency checks
  // only apply when storedFields is an actual array.
  if (Array.isArray(storedFields)) {
    const persisted = new Set(storedFields);
    for (const f of args.filterFields ?? []) {
      if (!persisted.has(f.field)) {
        throw new Error(
          `filterFields field "${f.field}" must be included in storedFields`,
        );
      }
    }
    for (const f of args.facetFields ?? []) {
      if (!persisted.has(f)) {
        throw new Error(
          `facetFields field "${f}" must be included in storedFields`,
        );
      }
    }
    for (const spec of args.sortSpecs ?? []) {
      for (const k of spec) {
        if (!persisted.has(k.field)) {
          throw new Error(
            `sortSpecs field "${k.field}" must be included in storedFields`,
          );
        }
      }
    }
  }
  if (args.rankProfiles) {
    const specIds = new Set((args.sortSpecs ?? []).map((s) => canonicalSpecId(s)));
    const persisted = Array.isArray(storedFields) ? new Set(storedFields) : null;
    const fieldOk = (f: string) => persisted === null || persisted.has(f);
    for (const [name, profile] of Object.entries(args.rankProfiles)) {
      if (!specIds.has(profile.base)) {
        throw new Error(`rankProfile "${name}" base "${profile.base}" must be a declared sortSpec`);
      }
      const seen = new Set<string>();
      for (const term of profile.terms) {
        if (seen.has(term.id)) throw new Error(`rankProfile "${name}" has duplicate term id "${term.id}"`);
        seen.add(term.id);
        if (term.type === "recencyDecay" && !(term.halfLifeMs > 0)) {
          throw new Error(`rankProfile "${name}" term "${term.id}" halfLifeMs must be > 0`);
        }
        if (term.type === "geoDistance" && !(term.maxKm > 0)) {
          throw new Error(`rankProfile "${name}" term "${term.id}" maxKm must be > 0`);
        }
        const fields =
          term.type === "geoDistance" ? [term.latField, term.lngField]
          : term.type === "relevance" ? []
          : [term.field];
        for (const f of fields) {
          if (!fieldOk(f)) {
            throw new Error(`rankProfile "${name}" term "${term.id}" field "${f}" must be included in storedFields`);
          }
        }
      }
    }
  }
}

export const createCollection = mutation({
  args: {
    name: v.string(),
    searchFields: v.array(v.string()),
    storedFields: v.optional(v.union(v.literal("all"), v.literal("derived"), v.array(v.string()))),
    filterFields: v.optional(
      v.array(
        v.object({
          field: v.string(),
          type: v.union(v.literal("string"), v.literal("number")),
        }),
      ),
    ),
    facetFields: v.optional(v.array(v.string())),
    sortSpecs: v.optional(
      v.array(
        v.array(
          v.object({
            field: v.string(),
            order: v.union(v.literal("asc"), v.literal("desc")),
          }),
        ),
      ),
    ),
    rankProfiles: v.optional(v.record(v.string(), rankProfileValidator)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await loadCollection(ctx, args.name);
    if (existing !== null) {
      throw new Error(`Collection "${args.name}" already exists`);
    }
    await blockIfDeletionInProgress(ctx, args.name);
    const storedFields = args.storedFields ?? "all";
    validateCollectionConfig({ ...args, storedFields });
    // Assign + persist the generic-slot mapping. Deterministic + stable
    // (first-declared field -> lowest free slot). assignSlots throws naming the
    // cap if more fields than slots are declared.
    // INVARIANT: createCollection must precede upsert -> every row carries a slotMap.
    const slotMap = assignSlots({
      searchFields: args.searchFields,
      filterFields: args.filterFields,
    });
    await ctx.db.insert("collections", {
      name: args.name,
      searchFields: args.searchFields,
      storedFields,
      filterFields: args.filterFields,
      facetFields: args.facetFields,
      sortSpecs: args.sortSpecs,
      rankProfiles: args.rankProfiles,
      slotMap,
    });
    return null;
  },
});

export const getCollection = query({
  args: { name: v.string() },
  returns: v.union(collectionDocValidator, v.null()),
  handler: async (ctx, args) => loadCollection(ctx, args.name),
});

export const deleteCollection = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const c = await requireCollection(ctx, args.name);
    const existingDeletion = await loadDeletion(ctx, args.name);
    if (!existingDeletion) {
      await ctx.db.insert("deletions", {
        name: args.name,
        sortSpecs: c.sortSpecs ?? [],
      });
    }
    await ctx.db.delete(c._id);

    let result: { done: boolean } = { done: false };
    for (let i = 0; i < DELETE_BATCHES_PER_PUBLIC_CALL && !result.done; i++) {
      result = await cleanupCollectionBatchInternal(
        ctx,
        args.name,
        c.sortSpecs ?? [],
        DELETE_BATCH_SIZE,
      );
    }
    if (!result.done) {
      await ctx.scheduler.runAfter(0, internal.collections.cleanupCollectionBatch, {
        name: args.name,
        sortSpecs: c.sortSpecs ?? [],
        batchSize: DELETE_BATCH_SIZE,
      });
    }
    return null;
  },
});

export const cleanupCollectionBatch = internalMutation({
  args: {
    name: v.string(),
    sortSpecs: v.array(sortSpecValidator),
    batchSize: v.optional(v.number()),
    scheduleNext: v.optional(v.boolean()),
  },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, args) => {
    const batchSize = Math.max(1, Math.floor(args.batchSize ?? DELETE_BATCH_SIZE));
    const result = await cleanupCollectionBatchInternal(
      ctx,
      args.name,
      args.sortSpecs,
      batchSize,
    );
    if (!result.done && (args.scheduleNext ?? true)) {
      await ctx.scheduler.runAfter(0, internal.collections.cleanupCollectionBatch, {
        name: args.name,
        sortSpecs: args.sortSpecs,
        batchSize,
        scheduleNext: true,
      });
    }
    return result;
  },
});
