import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

// See the example/convex/example.ts file for how to use this component.
//
// The scaffold's `comments` demo client (translate/exposeApi/list, which
// called component.lib.*) was removed along with the component's lib.ts.
// Real search client functions will be added in a later phase. The reusable
// ctx-type helpers below are kept for those functions.

export type { ComponentApi };

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
