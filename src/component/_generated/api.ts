/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as collections from "../collections.js";
import type * as configSync from "../configSync.js";
import type * as counters from "../counters.js";
import type * as diffCollection from "../diffCollection.js";
import type * as facetCounts from "../facetCounts.js";
import type * as filter from "../filter.js";
import type * as filterRank from "../filterRank.js";
import type * as fuzzy from "../fuzzy.js";
import type * as highlight from "../highlight.js";
import type * as http from "../http.js";
import type * as ranking from "../ranking.js";
import type * as score from "../score.js";
import type * as search from "../search.js";
import type * as searchRead from "../searchRead.js";
import type * as searchWrite from "../searchWrite.js";
import type * as slotMap from "../slotMap.js";
import type * as sortIndex from "../sortIndex.js";
import type * as stats from "../stats.js";
import type * as storedFields from "../storedFields.js";
import type * as tokenizer from "../tokenizer.js";
import type * as types from "../types.js";
import type * as write from "../write.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  collections: typeof collections;
  configSync: typeof configSync;
  counters: typeof counters;
  diffCollection: typeof diffCollection;
  facetCounts: typeof facetCounts;
  filter: typeof filter;
  filterRank: typeof filterRank;
  fuzzy: typeof fuzzy;
  highlight: typeof highlight;
  http: typeof http;
  ranking: typeof ranking;
  score: typeof score;
  search: typeof search;
  searchRead: typeof searchRead;
  searchWrite: typeof searchWrite;
  slotMap: typeof slotMap;
  sortIndex: typeof sortIndex;
  stats: typeof stats;
  storedFields: typeof storedFields;
  tokenizer: typeof tokenizer;
  types: typeof types;
  write: typeof write;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  docCount: import("@convex-dev/aggregate/_generated/component.js").ComponentApi<"docCount">;
  sortIndex: import("@convex-dev/aggregate/_generated/component.js").ComponentApi<"sortIndex">;
};
