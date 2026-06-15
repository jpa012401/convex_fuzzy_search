import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import type { SearchResult } from "../component/types.js";
import type { RankProfile } from "../component/schema.js";
import type { ApplyConfigResult } from "../component/configSync.js";

// See example/convex/products.ts for how to use this component.
// The reusable ctx-type helpers below are used by the FuzzySearch client.

export type { ComponentApi };
export type { SearchResult } from "../component/types.js";

// Convenient types for `ctx` args, that only include the bare minimum.

export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
export type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
export type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;

/**
 * Typed client for the Fuzzy Search component.
 *
 * Construct with the installed component reference, then call its methods
 * from your own Convex queries/mutations/actions:
 *
 * ```ts
 * const search = new FuzzySearch(components.fuzzySearch);
 * await search.upsert(ctx, { collection: "books", id: "1", doc: { title: "..." } });
 * ```
 */
export type CollectionConfigInput = {
  searchFields: string[];
  storedFields?: "all" | "derived" | string[];
  filterFields?: { field: string; type: "string" | "number" }[];
  facetFields?: string[];
  sortSpecs?: { field: string; order: "asc" | "desc" }[][];
  rankProfiles?: Record<string, RankProfile>;
};

export class FuzzySearch {
  constructor(
    public component: ComponentApi,
    private options?: { collections?: Record<string, CollectionConfigInput> },
  ) {}

  // Normalize configured collections into applyCollectionConfig args.
  private configEntries() {
    const cols = this.options?.collections ?? {};
    return Object.entries(cols).map(([name, c]) => ({
      name,
      searchFields: c.searchFields,
      storedFields: c.storedFields,
      filterFields: c.filterFields,
      facetFields: c.facetFields,
      sortSpecs: c.sortSpecs,
      rankProfiles: c.rankProfiles,
    }));
  }

  /**
   * Reconcile every configured collection's row to match the code config.
   * Idempotent and O(1) per collection (reads no documents). Metadata changes
   * apply in place; newly-added structural fields are returned as `pendingFields`
   * so the caller can trigger a reindex. Drive this once post-deploy.
   */
  async sync(ctx: MutationCtx) {
    const results: { name: string; kind: "create" | "update"; pendingFields: string[] }[] = [];
    for (const config of this.configEntries()) {
      const r = (await ctx.runMutation(
        this.component.configSync.applyCollectionConfig,
        { config },
      )) as ApplyConfigResult;
      results.push({ name: config.name, kind: r.kind, pendingFields: r.pendingFields });
    }
    return results;
  }

  async createCollection(
    ctx: MutationCtx,
    args: {
      name: string;
      searchFields: string[];
      storedFields?: "all" | string[];
      filterFields?: { field: string; type: "string" | "number" }[];
      facetFields?: string[];
      sortSpecs?: { field: string; order: "asc" | "desc" }[][];
      rankProfiles?: Record<string, {
        base: string;
        window?: number;
        terms: Array<
          | { id: string; type: "field"; weight: number; field: string }
          | { id: string; type: "flag"; weight: number; field: string; equals?: string }
          | { id: string; type: "setBoost"; weight: number; field: string; setKey: string }
          | { id: string; type: "recencyDecay"; weight: number; field: string; halfLifeMs: number }
          | { id: string; type: "geoDistance"; weight: number; latField: string; lngField: string; maxKm: number }
          | { id: string; type: "relevance"; weight: number }
        >;
      }>;
    },
  ) {
    return ctx.runMutation(this.component.collections.createCollection, args);
  }

  async getCollection(ctx: QueryCtx, name: string) {
    return ctx.runQuery(this.component.collections.getCollection, { name });
  }

  /**
   * Fields awaiting reindex for a collection (structural fields added via sync
   * whose existing documents have not been re-upserted yet). Empty when fully
   * indexed. Drive an app-side replay (re-upsert your docs) then clearPending().
   */
  async pendingFields(ctx: QueryCtx, collection: string): Promise<string[]> {
    const c = await ctx.runQuery(this.component.collections.getCollection, { name: collection });
    return ((c?.pendingFields as string[] | undefined) ?? []);
  }

  /** Mark a collection fully reindexed (call after replaying all documents). */
  async clearPending(ctx: MutationCtx, collection: string): Promise<void> {
    await ctx.runMutation(this.component.configSync.clearPendingFields, { collection });
  }

  async deleteCollection(ctx: MutationCtx, name: string) {
    return ctx.runMutation(this.component.collections.deleteCollection, {
      name,
    });
  }

  async upsert(
    ctx: MutationCtx,
    args: { collection: string; id: string; doc: Record<string, unknown> },
  ) {
    return ctx.runMutation(this.component.write.upsert, args);
  }

  async upsertMany(
    ctx: MutationCtx,
    args: {
      collection: string;
      docs: { id: string; doc: Record<string, unknown> }[];
    },
  ) {
    return ctx.runMutation(this.component.write.upsertMany, args);
  }

  async delete(
    ctx: MutationCtx,
    args: { collection: string; id: string },
  ) {
    return ctx.runMutation(this.component.write.delete, args);
  }

  // Backfill the doc counter for a collection, one bounded page at a time.
  // Returns the next cursor (null when done). Idempotent and safe to re-run.
  // For collections indexed before the aggregate counter existed.
  async backfillCounterPage(
    ctx: MutationCtx,
    args: { collection: string; cursor?: string | null; batch?: number },
  ): Promise<{ cursor: string | null; done: boolean }> {
    return ctx.runMutation(this.component.backfill.backfillCounterPage, args);
  }

  // Rebuild the filter index rows for a collection, one bounded page at a time.
  // Returns the next cursor (null when done). Idempotent and safe to re-run.
  // For collections indexed before the S2 filter index existed.
  async backfillFiltersPage(
    ctx: MutationCtx,
    args: { collection: string; cursor?: string | null; batch?: number },
  ): Promise<{ cursor: string | null; done: boolean }> {
    return ctx.runMutation(this.component.backfill.backfillFiltersPage, args);
  }

  // Rebuild the sort-index entries for a collection, one bounded page at a time.
  // Returns the next cursor (null when done). Idempotent (insert-if-absent), so
  // safe to re-run. For collections indexed before the S4 sort index existed.
  async backfillSortIndexPage(
    ctx: MutationCtx,
    args: { collection: string; cursor?: string | null; batch?: number },
  ): Promise<{ cursor: string | null; done: boolean }> {
    return ctx.runMutation(this.component.backfill.backfillSortIndexPage, args);
  }

  // Rebuild the facet-count rows for a collection, one bounded page at a time.
  // Returns the next cursor (null when done). Idempotent (clear-then-rebuild on
  // the first page), so a full run from the start is safe to re-run. For
  // collections indexed before the S3 facet counters existed.
  async backfillFacetCountsPage(
    ctx: MutationCtx,
    args: { collection: string; cursor?: string | null; batch?: number },
  ): Promise<{ cursor: string | null; done: boolean }> {
    return ctx.runMutation(this.component.backfill.backfillFacetCountsPage, args);
  }

  // Index-health snapshot: the live counts held in the aggregate/counter
  // components. For a fully-backfilled collection every facet `total` and every
  // sort-spec `count` equals `out_of`. Useful for validating a migration.
  async stats(
    ctx: QueryCtx,
    collection: string,
  ): Promise<{
    out_of: number;
    facets: { field: string; distinctValues: number; total: number }[];
    sortSpecs: { specId: string; count: number }[];
  }> {
    return ctx.runQuery(this.component.stats.stats, { collection });
  }

  async search(
    ctx: QueryCtx,
    args: {
      collection: string;
      q: string;
      page?: number;
      perPage?: number;
      queryBy?: string[];
      filterBy?: string;
      facetBy?: string[];
      maxFacetValues?: number;
      rankBy?: { text?: number; fields?: { field: string; weight: number }[] };
      sortBy?: { field: string; order: "asc" | "desc" }[];
      rank?: {
        profile: string;
        weights?: Record<string, number>;
        context?: { now?: number; origin?: { lat: number; lng: number }; sets?: Record<string, string[]> };
      };
    },
  ): Promise<SearchResult> {
    return ctx.runQuery(this.component.search.search, args);
  }
}
