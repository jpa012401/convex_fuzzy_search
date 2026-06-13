import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import { candidateTermsForToken } from "./matching";
import type { SearchResult, Hit } from "./types";

const MAX_PER_PAGE = 250;

// For one token's candidate terms, return docId -> best score among matched terms,
// restricted to queryBy fields when provided.
async function docScoresForToken(
  ctx: QueryCtx,
  collection: string,
  candidates: Map<string, number>,
  queryBy: string[] | undefined,
): Promise<Map<string, number>> {
  const docScore = new Map<string, number>();
  for (const [term, score] of candidates) {
    const rows = await ctx.db
      .query("postings")
      .withIndex("by_collection_term", (q) =>
        q.eq("collection", collection).eq("term", term),
      )
      .collect();
    for (const r of rows) {
      if (queryBy && !queryBy.includes(r.field)) continue;
      const cur = docScore.get(r.docId);
      if (cur === undefined || score > cur) docScore.set(r.docId, score);
    }
  }
  return docScore;
}

export const search = query({
  args: {
    collection: v.string(),
    q: v.string(),
    page: v.optional(v.number()),
    perPage: v.optional(v.number()),
    queryBy: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<SearchResult> => {
    const start = Date.now();
    await requireCollection(ctx, args.collection);

    const page = Math.max(1, Math.floor(args.page ?? 1));
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(args.perPage ?? 10)));

    const allDocs = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) => q.eq("collection", args.collection))
      .collect();
    const out_of = allDocs.length;

    const tokens = tokenize(args.q);

    let matchedIds: string[];
    let scoreById: Map<string, number> | null = null;

    if (tokens.length === 0) {
      matchedIds = allDocs.map((d) => d.docId).sort();
    } else {
      const perToken: Map<string, number>[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const candidates = await candidateTermsForToken(
          ctx,
          args.collection,
          tokens[i],
          i === tokens.length - 1,
        );
        perToken.push(
          await docScoresForToken(ctx, args.collection, candidates, args.queryBy),
        );
      }
      // AND across tokens: a doc must appear in every token's score map.
      perToken.sort((a, b) => a.size - b.size);
      const [first, ...rest] = perToken;
      scoreById = new Map();
      for (const [docId, s0] of first) {
        if (rest.every((m) => m.has(docId))) {
          let total = s0;
          for (const m of rest) total += m.get(docId)!;
          scoreById.set(docId, total);
        }
      }
      matchedIds = [...scoreById.keys()].sort((a, b) => {
        const d = scoreById!.get(b)! - scoreById!.get(a)!;
        return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
      });
    }

    const found = matchedIds.length;
    const pageIds = matchedIds.slice((page - 1) * perPage, (page - 1) * perPage + perPage);

    const byId = new Map(allDocs.map((d) => [d.docId, d.stored]));
    const hits: Hit[] = pageIds.map((id) => ({
      document: (byId.get(id) ?? {}) as Record<string, unknown>,
      highlight: {},
      text_match: scoreById ? (scoreById.get(id) ?? 0) : 0,
    }));

    return {
      found,
      page,
      out_of,
      search_time_ms: Date.now() - start,
      hits,
      facet_counts: [],
    };
  },
});
