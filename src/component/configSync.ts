import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { blockIfDeletionInProgress, loadCollection, validateCollectionConfig, requireCollection } from "./collections";
import { diffCollection } from "./diffCollection";
import { collectionConfigValidator } from "./schema";
import { assignSlots } from "./slotMap";

export type ApplyConfigResult = { kind: "create" | "update"; pendingFields: string[] };

// Idempotent upsert of a collection row from declarative config. Computes which
// structural fields are newly added (pendingFields) so the app can reindex.
// Metadata changes apply in place. Does NOT read documents.
export const applyCollectionConfig = mutation({
  args: { config: collectionConfigValidator },
  returns: v.object({
    kind: v.union(v.literal("create"), v.literal("update")),
    pendingFields: v.array(v.string()),
  }),
  handler: async (ctx, { config }): Promise<ApplyConfigResult> => {
    // applyCollectionConfig defaults storedFields to "derived" by design
    // (vs createCollection's "all"): config-synced collections store the
    // index-relevant projection (see project() in write.ts) rather than the
    // whole document, leaving the app to hydrate serving fields by id.
    const storedFields = config.storedFields ?? "derived";
    validateCollectionConfig({ ...config, storedFields });
    // Assign + persist the generic-slot mapping. Deterministic + stable
    // (first-declared field -> lowest free slot) so re-apply is idempotent.
    // assignSlots throws naming the cap if more fields than slots are declared.
    // INVARIANT: create/apply must precede upsert -> every row carries a slotMap.
    const slotMap = assignSlots({
      searchFields: config.searchFields,
      filterFields: config.filterFields,
    });
    const stored = await loadCollection(ctx, config.name);
    const next = {
      name: config.name,
      searchFields: config.searchFields,
      storedFields,
      filterFields: config.filterFields,
      facetFields: config.facetFields,
      sortSpecs: config.sortSpecs,
      rankProfiles: config.rankProfiles,
      slotMap,
    };
    const diff = diffCollection(stored ? { ...stored } : null, { ...next });
    if (stored === null) {
      // Mirror createCollection: refuse to re-create a row while a same-named
      // collection is still being torn down, else the live row would coexist
      // with index rows the background cleanup will delete out from under it.
      await blockIfDeletionInProgress(ctx, config.name);
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
  returns: v.null(),
  handler: async (ctx, { collection }) => {
    const c = await requireCollection(ctx, collection);
    await ctx.db.patch(c._id, { pendingFields: [] });
    return null;
  },
});
