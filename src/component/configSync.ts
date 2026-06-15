import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { loadCollection, validateCollectionConfig, requireCollection } from "./collections";
import { diffCollection } from "./diffCollection";
import { collectionConfigValidator } from "./schema";

export type ApplyConfigResult = { kind: "create" | "update"; pendingFields: string[] };

// Idempotent upsert of a collection row from declarative config. Computes which
// structural fields are newly added (pendingFields) so the app can reindex.
// Metadata changes apply in place. Does NOT read documents.
export const applyCollectionConfig = mutation({
  args: { config: collectionConfigValidator },
  handler: async (ctx, { config }): Promise<ApplyConfigResult> => {
    // applyCollectionConfig defaults storedFields to "derived" by design
    // (vs createCollection's "all"): config-synced collections will store the
    // index-relevant projection rather than the whole document. NOTE: the
    // projection itself is not yet implemented — "derived" currently stores the
    // whole doc (see project() in write.ts) until that work lands.
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

// Mark a collection fully reindexed. The app calls this after replaying all of
// its documents through upsert (which rebuilt the newly-added field's index rows).
export const clearPendingFields = mutation({
  args: { collection: v.string() },
  handler: async (ctx, { collection }) => {
    const c = await requireCollection(ctx, collection);
    await ctx.db.patch(c._id, { pendingFields: [] });
  },
});
