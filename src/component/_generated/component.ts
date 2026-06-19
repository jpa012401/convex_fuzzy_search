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
        null,
        Name
      >;
      deleteCollection: FunctionReference<
        "mutation",
        "internal",
        { name: string },
        null,
        Name
      >;
      getCollection: FunctionReference<
        "query",
        "internal",
        { name: string },
        {
          _creationTime: number;
          _id: string;
          facetFields?: Array<string>;
          filterFields?: Array<{ field: string; type: "string" | "number" }>;
          name: string;
          pendingFields?: Array<string>;
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
          storedFields: "all" | "derived" | Array<string>;
        } | null,
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
        { kind: "create" | "update"; pendingFields: Array<string> },
        Name
      >;
      clearPendingFields: FunctionReference<
        "mutation",
        "internal",
        { collection: string },
        null,
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
        {
          facet_counts: Array<{
            counts: Array<{ count: number; value: string }>;
            field_name: string;
          }>;
          found: number;
          found_approximate: boolean;
          hits: Array<{
            highlight: Record<
              string,
              { matched_tokens: Array<string>; snippet: string }
            >;
            id: string;
            score: number;
          }>;
          out_of: number;
          page: number;
          reranked: boolean;
        },
        Name
      >;
    };
    stats: {
      stats: FunctionReference<
        "query",
        "internal",
        { collection: string },
        {
          facetPostings: Array<{
            distinctValues: number;
            field: string;
            totalDocKeys: number;
          }>;
          facets: Array<{
            distinctValues: number;
            field: string;
            total: number;
            truncated: boolean;
          }>;
          filterPostings: Array<{
            distinctOrBuckets: number;
            field: string;
            totalDocKeys: number;
          }>;
          out_of: number;
          sortSpecs: Array<{ count: number; specId: string }>;
        },
        Name
      >;
    };
    write: {
      delete: FunctionReference<
        "mutation",
        "internal",
        { collection: string; id: string },
        null,
        Name
      >;
      deleteDoc: FunctionReference<
        "mutation",
        "internal",
        { collection: string; id: string },
        null,
        Name
      >;
      upsert: FunctionReference<
        "mutation",
        "internal",
        { collection: string; doc: any; id: string },
        null,
        Name
      >;
      upsertMany: FunctionReference<
        "mutation",
        "internal",
        { collection: string; docs: Array<{ doc: any; id: string }> },
        null,
        Name
      >;
    };
  };
