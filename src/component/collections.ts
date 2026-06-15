import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { clearCollectionCount } from "./counters";
import { clearCollectionFacets } from "./facetCounts";
import { canonicalSpecId, clearCollectionSort } from "./sortIndex";
import { rankProfileValidator } from "./schema";

export async function loadCollection(ctx: QueryCtx, name: string) {
  return await ctx.db
    .query("collections")
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

export function validateCollectionConfig(args: {
  storedFields: "all" | "derived" | string[];
  searchFields: string[];
  filterFields?: { field: string; type: "string" | "number" }[];
  facetFields?: string[];
  sortSpecs?: { field: string; order: "asc" | "desc" }[][];
  rankProfiles?: Record<string, { base: string; terms: any[] }>;
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
  handler: async (ctx, args) => {
    const existing = await loadCollection(ctx, args.name);
    if (existing !== null) {
      throw new Error(`Collection "${args.name}" already exists`);
    }
    const storedFields = args.storedFields ?? "all";
    validateCollectionConfig({ ...args, storedFields });
    await ctx.db.insert("collections", {
      name: args.name,
      searchFields: args.searchFields,
      storedFields,
      filterFields: args.filterFields,
      facetFields: args.facetFields,
      sortSpecs: args.sortSpecs,
      rankProfiles: args.rankProfiles,
    });
  },
});

export const getCollection = query({
  args: { name: v.string() },
  handler: async (ctx, args) => loadCollection(ctx, args.name),
});

export const deleteCollection = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const c = await requireCollection(ctx, args.name);
    for (const table of ["postings", "documents"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_collection_doc", (q) => q.eq("collection", args.name))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
    // terms + trigrams are keyed by [collection, term], not [collection, docId]
    for (const table of ["terms", "trigrams"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_collection_term", (q) => q.eq("collection", args.name))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
    const filterRows = await ctx.db
      .query("filters")
      .withIndex("by_doc", (q) => q.eq("collection", args.name))
      .collect();
    for (const r of filterRows) await ctx.db.delete(r._id);
    await clearCollectionCount(ctx, args.name);
    await clearCollectionFacets(ctx, args.name);
    await clearCollectionSort(ctx, args.name, c.sortSpecs ?? []);
    await ctx.db.delete(c._id);
  },
});
