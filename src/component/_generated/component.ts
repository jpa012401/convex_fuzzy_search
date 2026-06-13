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
          name: string;
          searchFields: Array<string>;
          storedFields?: "all" | Array<string>;
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
  };
