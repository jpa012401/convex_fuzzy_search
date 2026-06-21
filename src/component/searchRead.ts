import { tokenize } from "./tokenizer";
import type { QueryCtx } from "./_generated/server";
import type { SlotMap } from "./slotMap";

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
export async function runEmptyQFilterQuery(
  ctx: QueryCtx,
  collection: string,
  eq: { slot: string; value: string | number }[],
  postFilter: ((stored: Record<string, unknown>) => boolean) | null,
  take: number,
): Promise<Candidate[]> {
  const rows = await ctx.db
    .query("searchDocs")
    .withIndex("by_collection_doc", (q) => q.eq("collection", collection))
    .take(Math.max(1, take));
  const out: Candidate[] = [];
  let pos = 0;
  for (const row of rows) {
    const slotsOk = eq.every((e) => (row as Record<string, unknown>)[e.slot] === e.value);
    if (!slotsOk) continue;
    const stored = (row.stored ?? {}) as Record<string, unknown>;
    if (postFilter && !postFilter(stored)) continue;
    out.push({ docId: row.docId, stored, slotText: "", rankPos: pos++ });
  }
  return out;
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
