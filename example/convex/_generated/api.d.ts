/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as dataset from "../dataset.js";
import type * as places from "../places.js";
import type * as placesData from "../placesData.js";
import type * as products from "../products.js";
import type * as smoke from "../smoke.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  dataset: typeof dataset;
  places: typeof places;
  placesData: typeof placesData;
  products: typeof products;
  smoke: typeof smoke;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  fuzzySearch: import("@elevatech/fuzzy-search/_generated/component.js").ComponentApi<"fuzzySearch">;
};
