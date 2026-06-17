import type { QueryCtx } from "./_generated/server";
import { candidateTermsForToken } from "./matching";
import { loadDocumentByDocKey } from "./docKeys";
import { loadDocTerms, readTermPostings } from "./postingChunks";

// Max postings rows read while collecting the driver token. Headroom under the
// ~4096 reads/query limit. Exceeding it truncates the driver scan (approximate).
export const POSTINGS_BUDGET = 4000;

type Candidates = Map<string, { score: number; docCount: number }>;

// Best candidate score for a doc given the terms present on it, or undefined.
function bestScore(present: Map<string, number>, candidates: Candidates): number | undefined {
  let best: number | undefined;
  for (const [term, _tf] of present) {
    const c = candidates.get(term);
    if (c && (best === undefined || c.score > best)) best = c.score;
  }
  return best;
}

export async function matchTokens(
  ctx: QueryCtx,
  collection: string,
  tokens: string[],
  queryBy: string[] | undefined,
  budget: number = POSTINGS_BUDGET,
): Promise<{
  scoreById: Map<string, number>;
  matchedTerms: Set<string>;
  truncated: boolean;
  singleExactTerm: string | null;
}> {
  // 1. Candidates + selectivity per token.
  const perToken: { candidates: Candidates; est: number }[] = [];
  const matchedTerms = new Set<string>();
  let candidateTruncated = false;
  for (let i = 0; i < tokens.length; i++) {
    const result = await candidateTermsForToken(ctx, collection, tokens[i], i === tokens.length - 1);
    const candidates = result.candidates;
    candidateTruncated ||= result.truncated;
    let est = 0;
    for (const [term, c] of candidates) {
      matchedTerms.add(term);
      est += c.docCount;
    }
    perToken.push({ candidates, est });
  }

  if (perToken.length === 0) {
    return { scoreById: new Map(), matchedTerms, truncated: false, singleExactTerm: null };
  }

  // singleExactTerm: one token whose only candidate is the token itself.
  let singleExactTerm: string | null = null;
  if (tokens.length === 1) {
    const only = perToken[0].candidates;
    if (only.size === 1 && only.has(tokens[0])) singleExactTerm = tokens[0];
  }

  // 2. Driver = most selective token (smallest estimated docCount).
  let driverIdx = 0;
  for (let i = 1; i < perToken.length; i++) {
    if (perToken[i].est < perToken[driverIdx].est) driverIdx = i;
  }
  const driver = perToken[driverIdx];

  // Early exit: if any token has zero candidates, the AND intersection is empty.
  for (const tok of perToken) {
    if (tok.candidates.size === 0) {
      return { scoreById: new Map(), matchedTerms, truncated: candidateTruncated, singleExactTerm };
    }
  }

  // 3. Collect driver postings (budget-capped) -> docKey -> best driver score.
  //    Stream with `for await` and stop at the budget so we actually READ at
  //    most `budget` entries — collecting a hot term without a cap
  //    before the cap could apply, blowing the per-query read limit.
  const driverScore = new Map<number, number>();
  let read = 0;
  let truncated = candidateTruncated;
  outer: for (const [term, c] of driver.candidates) {
    for await (const r of readTermPostings(ctx, collection, term)) {
      if (read >= budget) { truncated = true; break outer; }
      read++;
      if (queryBy && !queryBy.includes(r.field)) continue;
      const cur = driverScore.get(r.docKey);
      if (cur === undefined || c.score > cur) driverScore.set(r.docKey, c.score);
    }
  }

  // 4. Verify the other tokens per driver doc. Read each doc's terms ONCE,
  //    then check every non-driver token against that single term set.
  const others = perToken.filter((_, i) => i !== driverIdx);
  const scoreById = new Map<string, number>();
  for (const [docKey, dScore] of driverScore) {
    let present: Map<string, number> | null = null;
    if (others.length > 0) {
      const postings = await loadDocTerms(ctx, collection, docKey);
      present = new Map<string, number>();
      for (const p of postings) {
        if (queryBy && !queryBy.includes(p.field)) continue;
        present.set(p.term, p.tf);
      }
    }
    let total = dScore;
    let ok = true;
    for (const tok of others) {
      const s = bestScore(present as Map<string, number>, tok.candidates);
      if (s === undefined) { ok = false; break; }
      total += s;
    }
    if (ok) {
      const doc = await loadDocumentByDocKey(ctx, collection, docKey);
      if (doc) scoreById.set(doc.docId, total);
    }
  }

  return { scoreById, matchedTerms, truncated, singleExactTerm };
}
