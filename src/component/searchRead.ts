import { tokenize } from "./tokenizer";
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
