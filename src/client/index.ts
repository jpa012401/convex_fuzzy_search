import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import type { SearchResult } from "../component/types.js";

// See the example/convex/example.ts file for how to use this component.
//
// The scaffold's `comments` demo client (translate/exposeApi/list, which
// called component.lib.*) was removed along with the component's lib.ts.
// The reusable ctx-type helpers below are used by the TypesenseSearch client.

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
 * Typed client for the Typesense search component.
 *
 * Construct with the installed component reference, then call its methods
 * from your own Convex queries/mutations/actions:
 *
 * ```ts
 * const search = new TypesenseSearch(components.typesenseSearch);
 * await search.upsert(ctx, { collection: "books", id: "1", doc: { title: "..." } });
 * ```
 */
export class TypesenseSearch {
  constructor(public component: ComponentApi) {}

  async createCollection(
    ctx: MutationCtx,
    args: {
      name: string;
      searchFields: string[];
      storedFields?: "all" | string[];
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

  async search(
    ctx: QueryCtx,
    args: {
      collection: string;
      q: string;
      page?: number;
      perPage?: number;
      queryBy?: string[];
    },
  ): Promise<SearchResult> {
    return ctx.runQuery(this.component.search.search, args);
  }
}
