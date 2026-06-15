/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    backfill: {
      backfillCounterPage: FunctionReference<
        "mutation",
        "internal",
        { batch?: number; collection: string; cursor?: string | null },
        any,
        Name
      >;
      backfillFacetCountsPage: FunctionReference<
        "mutation",
        "internal",
        { batch?: number; collection: string; cursor?: string | null },
        any,
        Name
      >;
      backfillFiltersPage: FunctionReference<
        "mutation",
        "internal",
        { batch?: number; collection: string; cursor?: string | null },
        any,
        Name
      >;
      backfillSortIndexPage: FunctionReference<
        "mutation",
        "internal",
        { batch?: number; collection: string; cursor?: string | null },
        any,
        Name
      >;
    };
    collections: {
      createCollection: FunctionReference<
        "mutation",
        "internal",
        {
          facetFields?: Array<string>;
          filterFields?: Array<{ field: string; type: "string" | "number" }>;
          name: string;
          rankProfiles?: Record<
            string,
            {
              base: string;
              terms: Array<
                | { field: string; id: string; type: "field"; weight: number }
                | {
                    equals?: string;
                    field: string;
                    id: string;
                    type: "flag";
                    weight: number;
                  }
                | {
                    field: string;
                    id: string;
                    setKey: string;
                    type: "setBoost";
                    weight: number;
                  }
                | {
                    field: string;
                    halfLifeMs: number;
                    id: string;
                    type: "recencyDecay";
                    weight: number;
                  }
                | {
                    id: string;
                    latField: string;
                    lngField: string;
                    maxKm: number;
                    type: "geoDistance";
                    weight: number;
                  }
                | { id: string; type: "relevance"; weight: number }
              >;
              window?: number;
            }
          >;
          searchFields: Array<string>;
          sortSpecs?: Array<Array<{ field: string; order: "asc" | "desc" }>>;
          storedFields?: "all" | "derived" | Array<string>;
        },
        any,
        Name
      >;
      deleteCollection: FunctionReference<
        "mutation",
        "internal",
        { name: string },
        any,
        Name
      >;
      getCollection: FunctionReference<
        "query",
        "internal",
        { name: string },
        any,
        Name
      >;
    };
    configSync: {
      applyCollectionConfig: FunctionReference<
        "mutation",
        "internal",
        {
          config: {
            facetFields?: Array<string>;
            filterFields?: Array<{ field: string; type: "string" | "number" }>;
            name: string;
            rankProfiles?: Record<
              string,
              {
                base: string;
                terms: Array<
                  | { field: string; id: string; type: "field"; weight: number }
                  | {
                      equals?: string;
                      field: string;
                      id: string;
                      type: "flag";
                      weight: number;
                    }
                  | {
                      field: string;
                      id: string;
                      setKey: string;
                      type: "setBoost";
                      weight: number;
                    }
                  | {
                      field: string;
                      halfLifeMs: number;
                      id: string;
                      type: "recencyDecay";
                      weight: number;
                    }
                  | {
                      id: string;
                      latField: string;
                      lngField: string;
                      maxKm: number;
                      type: "geoDistance";
                      weight: number;
                    }
                  | { id: string; type: "relevance"; weight: number }
                >;
                window?: number;
              }
            >;
            searchFields: Array<string>;
            sortSpecs?: Array<Array<{ field: string; order: "asc" | "desc" }>>;
            storedFields?: "all" | "derived" | Array<string>;
          };
        },
        any,
        Name
      >;
    };
    search: {
      search: FunctionReference<
        "query",
        "internal",
        {
          collection: string;
          facetBy?: Array<string>;
          filterBy?: string;
          maxFacetValues?: number;
          page?: number;
          perPage?: number;
          q: string;
          queryBy?: Array<string>;
          rank?: {
            context?: {
              now?: number;
              origin?: { lat: number; lng: number };
              sets?: Record<string, Array<string>>;
            };
            profile: string;
            weights?: Record<string, number>;
          };
          rankBy?: {
            fields?: Array<{ field: string; weight: number }>;
            text?: number;
          };
          sortBy?: Array<{ field: string; order: "asc" | "desc" }>;
        },
        any,
        Name
      >;
    };
    stats: {
      stats: FunctionReference<
        "query",
        "internal",
        { collection: string },
        any,
        Name
      >;
    };
    write: {
      delete: FunctionReference<
        "mutation",
        "internal",
        { collection: string; id: string },
        any,
        Name
      >;
      deleteDoc: FunctionReference<
        "mutation",
        "internal",
        { collection: string; id: string },
        any,
        Name
      >;
      upsert: FunctionReference<
        "mutation",
        "internal",
        { collection: string; doc: any; id: string },
        any,
        Name
      >;
      upsertMany: FunctionReference<
        "mutation",
        "internal",
        { collection: string; docs: Array<{ doc: any; id: string }> },
        any,
        Name
      >;
    };
  };
