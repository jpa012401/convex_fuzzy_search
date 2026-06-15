import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { loadCollection, validateCollectionConfig } from "./collections";
import { diffCollection } from "./diffCollection";
import { rankProfileValidator } from "./schema";

const configValidator = v.object({
  name: v.string(),
  searchFields: v.array(v.string()),
  storedFields: v.optional(v.union(v.literal("all"), v.literal("derived"), v.array(v.string()))),
  filterFields: v.optional(v.array(v.object({ field: v.string(), type: v.union(v.literal("string"), v.literal("number")) }))),
  facetFields: v.optional(v.array(v.string())),
  sortSpecs: v.optional(v.array(v.array(v.object({ field: v.string(), order: v.union(v.literal("asc"), v.literal("desc")) })))),
  rankProfiles: v.optional(v.record(v.string(), rankProfileValidator)),
});

// Idempotent upsert of a collection row from declarative config. Computes which
// structural fields are newly added (pendingFields) so the app can reindex.
// Metadata changes apply in place. Does NOT read documents.
export const applyCollectionConfig = mutation({
  args: { config: configValidator },
  handler: async (ctx, { config }) => {
    const storedFields = config.storedFields ?? "derived";
    validateCollectionConfig({ ...config, storedFields });
    const stored = await loadCollection(ctx, config.name);
    const next = {
      name: config.name,
      searchFields: config.searchFields,
      storedFields,
      filterFields: config.filterFields,
      facetFields: config.facetFields,
      sortSpecs: config.sortSpecs,
      rankProfiles: config.rankProfiles,
    };
    const diff = diffCollection(stored ? { ...stored } : null, { ...next });
    if (stored === null) {
      await ctx.db.insert("collections", { ...next, pendingFields: [] });
      return { kind: "create" as const, pendingFields: [] as string[] };
    }
    const pending = [...new Set([...(stored.pendingFields ?? []), ...diff.pendingFields])];
    await ctx.db.patch(stored._id, { ...next, pendingFields: pending });
    return { kind: "update" as const, pendingFields: pending };
  },
});
