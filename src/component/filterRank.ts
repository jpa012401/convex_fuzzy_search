import {
  parseFilterAst,
  astToPredicate,
  type Ast,
  type Predicate,
  type FieldType,
} from "./filter";
import type { SlotMap } from "./slotMap";
import type { RankProfile } from "./schema";
import type { RankContext } from "./score";

export type EqClause = { slot: string; value: string | number };
export type ResolvedFilters = { eq: EqClause[]; postFilter: Predicate | null };

// Try to express `ast` as a conjunction of native-.eq clauses on slot-mapped
// fields. Collects pushable EqClauses into `eq` and the residual (anything native
// .eq cannot do) into `residual` Asts. Returns false if the whole subtree is
// non-pushable (e.g. an OR), in which case the caller keeps the entire subtree
// as residual. Equality on an unmapped field is not pushable -> residual.
function collect(
  ast: Ast,
  slotMap: SlotMap,
  eq: EqClause[],
  residual: Ast[],
): void {
  switch (ast.kind) {
    case "and":
      collect(ast.left, slotMap, eq, residual);
      collect(ast.right, slotMap, eq, residual);
      return;
    case "exact": {
      const slot =
        ast.type === "number"
          ? slotMap.numFilter[ast.field]
          : slotMap.strFilter[ast.field];
      if (slot) {
        eq.push({ slot, value: ast.type === "number" ? Number(ast.value) : ast.value });
      } else {
        residual.push(ast);
      }
      return;
    }
    // or / inSet / cmp / range: not expressible as a single native .eq -> residual.
    default:
      residual.push(ast);
      return;
  }
}

export function resolveEqFilters(
  filterBy: string,
  slotMap: SlotMap,
  fieldTypes: Record<string, FieldType>,
): ResolvedFilters {
  if (!filterBy || filterBy.trim() === "") return { eq: [], postFilter: null };
  const ast = parseFilterAst(filterBy, fieldTypes);
  const eq: EqClause[] = [];
  const residual: Ast[] = [];
  collect(ast, slotMap, eq, residual);
  if (residual.length === 0) return { eq, postFilter: null };
  // Combine residual clauses with AND, then build one in-memory Predicate.
  const combined = residual.reduce((left, right) => ({ kind: "and" as const, left, right }));
  return { eq, postFilter: astToPredicate(combined) };
}

export type ResolvedRank = {
  profile: RankProfile;
  weights?: Record<string, number>;
  context?: RankContext;
};

// Verbatim extraction of search.ts lines 93-104 (rank profile lookup + weight-id
// validation), returning the resolved profile + pass-through weights/context.
export function resolveRankProfile(
  collection: { rankProfiles?: Record<string, RankProfile> },
  rank: { profile: string; weights?: Record<string, number>; context?: RankContext } | undefined,
): ResolvedRank | undefined {
  const rankProfile = rank ? collection.rankProfiles?.[rank.profile] : undefined;
  if (rank && !rankProfile) {
    throw new Error(`Unknown rank profile "${rank.profile}"`);
  }
  if (rank?.weights && rankProfile) {
    const termIds = new Set(rankProfile.terms.map((t) => t.id));
    for (const id of Object.keys(rank.weights)) {
      if (!termIds.has(id)) {
        throw new Error(`Unknown rank weight override "${id}" for profile "${rank.profile}"`);
      }
    }
  }
  if (!rankProfile) return undefined;
  return { profile: rankProfile, weights: rank!.weights, context: rank!.context };
}
