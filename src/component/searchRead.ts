import { tokenize } from "./tokenizer";
import type { QueryCtx } from "./_generated/server";
import type { SlotMap } from "./slotMap";
import { suggestTerms } from "./termDict";
import { evalTerms, type RankContext } from "./score";
import { orderingScore, compareMatches, type RankBy, type SortKey } from "./ranking";
import type { RankProfile } from "./schema";
import { readFacetCounts } from "./facetCounts";
import type { FacetCount } from "./types";

// F2: the ONE candidate type shared across read + rank + facet layers.
// rankPos = native result index (0-based); slotText = the searched slot's raw
// text, used for AND re-verify and highlighting.
export type Candidate = {
  docId: string;
  stored: Record<string, unknown>;
  slotText: string;
  rankPos: number;
};

// F3: the ONE synthScore. rank 0 of N -> 1.0, last (N-1) -> ~1/N.
export function synthScore(rankPos: number, total: number): number {
  return total <= 0 ? 0 : (total - rankPos) / total;
}

// Native search is OR-by-relevance. Re-impose AND app-side: keep only candidates
// whose slotText (re-tokenized) contains every query token. Empty token list ->
// pass-through. Order is preserved.
export function reverifyAnd(cands: Candidate[], queryTokens: string[]): Candidate[] {
  if (queryTokens.length === 0) return cands;
  return cands.filter((c) => {
    const present = new Set(tokenize(c.slotText));
    return queryTokens.every((tok) => present.has(tok));
  });
}

// Choose which native search index to query. A single queryBy field maps to its
// dedicated textN slot (index sN); zero or multiple fields fall back to text0
// (s0), the concatenation of ALL searchFields.
export function pickSearchSlot(
  queryBy: string[] | undefined,
  slotMap: SlotMap,
): { indexName: string; slot: string } {
  if (queryBy && queryBy.length === 1) {
    const field = queryBy[0];
    const slot = slotMap.search[field];
    if (!slot) {
      throw new Error(`queryBy "${field}" is not a searchable field for this collection`);
    }
    const indexName = "s" + slot.slice("text".length);
    return { indexName, slot };
  }
  return { indexName: "s0", slot: "text0" };
}

// Clamp the re-rank window to native search's hard ceiling. Native .take above
// 1024 THROWS ("scanned too many documents"), so K is always in [1, 1024].
export function clampK(window: number): number {
  return Math.min(1024, Math.max(1, Math.floor(window)));
}

// F8: empty-q + filter path. Native search needs a query string, so for the
// browse-with-filter case we scan by_collection_doc (scoped to the collection),
// apply the native-expressible eq() in memory + the residual postFilter, and
// bound the read with take(). Deterministic + convex-test-runnable.
// Returns candidates plus windowFull=true when the .take() scan hit the ceiling
// (rows.length >= take), meaning there may be unseen matching docs — callers
// MUST propagate this as found_approximate=true (spec §6).
export async function runEmptyQFilterQuery(
  ctx: QueryCtx,
  collection: string,
  eq: { slot: string; value: string | number }[],
  postFilter: ((stored: Record<string, unknown>) => boolean) | null,
  take: number,
): Promise<{ candidates: Candidate[]; windowFull: boolean }> {
  const clampedTake = Math.max(1, take);
  const rows = await ctx.db
    .query("searchDocs")
    .withIndex("by_collection_doc", (q) => q.eq("collection", collection))
    .take(clampedTake);
  const windowFull = rows.length >= clampedTake;
  const candidates: Candidate[] = [];
  let pos = 0;
  for (const row of rows) {
    const slotsOk = eq.every((e) => (row as Record<string, unknown>)[e.slot] === e.value);
    if (!slotsOk) continue;
    const stored = (row.stored ?? {}) as Record<string, unknown>;
    if (postFilter && !postFilter(stored)) continue;
    candidates.push({ docId: row.docId, stored, slotText: "", rankPos: pos++ });
  }
  return { candidates, windowFull };
}

// Native text retrieval over the slot pool. Picks the slot via pickSearchSlot:
// a single queryBy field maps to its search slot via slotMap.search; otherwise
// text0 (all-text). Always .eq("collection", name)-scoped; native-expressible
// eq filters chained on filtN/numFN. .take(K), K = clampK(window).
// Builds Candidate[] (rankPos = native result index, slotText = searched slot text).
// NOTE: convex-test does NOT simulate native .searchIndex — this path is asserted
// in the Task-12 smoke via `npx convex run`, not in vitest.
export async function runTextQuery(
  ctx: QueryCtx,
  collection: { name: string; searchFields: string[] },
  args: { q: string; queryBy?: string[] | undefined },
  slotMap: SlotMap,
  eq: { slot: string; value: string | number }[],
  window: number,
): Promise<{ candidates: Candidate[]; searchedSlot: string; indexName: string; found_approximate: boolean }> {
  const K = clampK(window);
  // Use pickSearchSlot for consistent slot/index selection.
  const { indexName, slot } = pickSearchSlot(args.queryBy, slotMap);
  const q = args.q;
  const rows = await ctx.db
    .query("searchDocs")
    .withSearchIndex(indexName as any, (b: any) => {
      let f = b.search(slot, q).eq("collection", collection.name);
      for (const e of eq) f = f.eq(e.slot, e.value);
      return f;
    })
    .take(K);
  const candidates: Candidate[] = rows.map((row, i) => ({
    docId: row.docId,
    stored: (row.stored ?? {}) as Record<string, unknown>,
    slotText: String((row as Record<string, unknown>)[slot] ?? ""),
    rankPos: i,
  }));
  // found_approximate when the native window was filled: the true AND set may
  // extend past the <=K OR-ranked window.
  const found_approximate = rows.length >= K;
  return { candidates, searchedSlot: slot, indexName, found_approximate };
}

// F2: Order the <=K candidate window. When a rank profile is present, score each
// candidate with evalTerms(stored, terms, weights, synthScore(rankPos,total), context)
// and sort descending. Otherwise, use orderingScore + compareMatches (which handles
// rankBy, sortBy, and default relevance). All ordering happens in memory.
export function orderCandidates(
  candidates: Candidate[],
  opts: {
    rank?: { profile: RankProfile; weights?: Record<string, number>; context?: RankContext };
    rankBy?: RankBy;
    sortBy?: SortKey[];
  },
): Candidate[] {
  const total = candidates.length;
  const out = [...candidates];
  if (opts.rank) {
    const { profile, weights, context } = opts.rank;
    const ctx = context ?? {};
    const baseIdx = new Map(out.map((cnd, i) => [cnd.docId, i])); // native-rank tiebreak
    const score = (cnd: Candidate) =>
      evalTerms(cnd.stored, profile.terms, weights, synthScore(cnd.rankPos, total), ctx);
    out.sort((a, b) => score(b) - score(a) || (baseIdx.get(a.docId)! - baseIdx.get(b.docId)!));
    return out;
  }
  // Relevance / rankBy / sortBy path via the kept comparator.
  const storedOf = (id: string) => out.find((x) => x.docId === id)!.stored;
  const relevance = (id: string) => {
    const cnd = out.find((x) => x.docId === id)!;
    return orderingScore(synthScore(cnd.rankPos, total), cnd.stored, opts.rankBy);
  };
  out.sort((a, b) =>
    compareMatches(a.docId, b.docId, { score: relevance, stored: storedOf, sortBy: opts.sortBy }),
  );
  return out;
}

// Load a single doc's stored projection from searchDocs (used by browse/rank branches
// that need stored fields from searchDocs instead of the removed documents table).
export async function loadStored(
  ctx: QueryCtx,
  collection: string,
  docId: string,
): Promise<Record<string, unknown>> {
  const row = await ctx.db
    .query("searchDocs")
    .withIndex("by_collection_doc", (q) => q.eq("collection", collection).eq("docId", docId))
    .unique();
  return (row?.stored ?? {}) as Record<string, unknown>;
}

// F5 (query-scoped): Tally stored field values over the <=K candidate window.
// Ordering: count desc, then value asc — matching readFacetCounts. Missing/null skipped.
export function tallyFacets(
  candidates: Candidate[],
  fields: string[],
  maxValues: number,
): FacetCount[] {
  const out: FacetCount[] = [];
  for (const field of fields) {
    const tally = new Map<string, number>();
    for (const cnd of candidates) {
      const raw = cnd.stored[field];
      if (raw === undefined || raw === null) continue;
      const value = String(raw);
      tally.set(value, (tally.get(value) ?? 0) + 1);
    }
    const counts = [...tally.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, Math.max(0, maxValues))
      .map(([value, count]) => ({ value, count }));
    out.push({ field_name: field, counts });
  }
  return out;
}

// ON-MISS TYPO CORRECTION (Task 15): if a text query returns zero results after
// reverifyAnd, try to correct each token via the trigram dictionary and return
// the corrected token list. Returns null when no correction was found (so the
// caller can skip the retry). Testable in convex-test (reads trigrams table
// only; does NOT call native .searchIndex).
export async function suggestCorrectTokens(
  ctx: QueryCtx,
  collection: string,
  tokens: string[],
): Promise<string[] | null> {
  const corrected: string[] = [];
  let anyChanged = false;
  for (const token of tokens) {
    const suggestions = await suggestTerms(ctx, collection, token);
    if (suggestions.length > 0 && suggestions[0] !== token) {
      corrected.push(suggestions[0]);
      anyChanged = true;
    } else {
      corrected.push(token);
    }
  }
  return anyChanged ? corrected : null;
}

// F5/F6: Branch on queryPresent.
//   queryPresent -> tally over the <=K candidate window (facets_scoped=true);
//                  found = reverified candidate count.
//   empty-q browse -> readFacetCounts over the facetCounts TABLE (facets_scoped=false);
//                     found = browseOutOf (from the docCount aggregate).
// Throws on any undeclared facet field (parity with existing handler in search.ts).
export async function resolveFoundAndFacets(
  ctx: QueryCtx,
  collection: string,
  candidates: Candidate[],
  opts: {
    queryPresent: boolean;
    facetFields: string[];
    declaredFacets: Set<string>;
    maxFacetValues: number;
    foundApproximate: boolean;
    browseOutOf?: number;
  },
): Promise<{ found: number; facet_counts: FacetCount[]; facets_scoped: boolean }> {
  for (const field of opts.facetFields) {
    if (!opts.declaredFacets.has(field)) {
      throw new Error(`Field "${field}" is not a declared facet field`);
    }
  }
  if (opts.queryPresent) {
    const facet_counts = tallyFacets(candidates, opts.facetFields, opts.maxFacetValues);
    // found = reverified candidate count; found_approximate already carries the
    // ">K" caveat (F6). facets are over the relevance-biased <=K window -> scoped.
    return { found: candidates.length, facet_counts, facets_scoped: opts.facetFields.length > 0 };
  }
  // Empty-q browse/declared facets: counts from the facetCounts TABLE (F5),
  // bounded by FACET_VALUE_READ_BUDGET (field cardinality, not collection size).
  const facet_counts: FacetCount[] = [];
  for (const field of opts.facetFields) {
    facet_counts.push({
      field_name: field,
      counts: await readFacetCounts(ctx, collection, field, opts.maxFacetValues),
    });
  }
  return { found: opts.browseOutOf ?? candidates.length, facet_counts, facets_scoped: false };
}
