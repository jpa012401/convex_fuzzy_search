import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import type { SearchResult } from "../component/types.js";

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
export class FuzzySearch {
  constructor(public component: ComponentApi) {}

  async createCollection(
    ctx: MutationCtx,
    args: {
      name: string;
      searchFields: string[];
      storedFields?: "all" | string[];
      filterFields?: { field: string; type: "string" | "number" }[];
      facetFields?: string[];
    },
  ) {
    return ctx.runMutation(this.component.collections.createCollection, args);
  }

  async getCollection(ctx: QueryCtx, name: string) {
    return ctx.runQuery(this.component.collections.getCollection, { name });
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
    },
  ): Promise<SearchResult> {
    return ctx.runQuery(this.component.search.search, args);
  }
}
