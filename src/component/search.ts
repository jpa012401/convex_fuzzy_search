import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import { candidateTermsForToken } from "./matching";
import { parseFilter } from "./filter";
import { highlightField } from "./highlight";
import { orderingScore, compareMatches } from "./ranking";
import type { SearchResult, Hit, FacetCount } from "./types";

const MAX_PER_PAGE = 250;

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
    filterBy: v.optional(v.string()),
    facetBy: v.optional(v.array(v.string())),
    maxFacetValues: v.optional(v.number()),
    rankBy: v.optional(
      v.object({
        text: v.optional(v.number()),
        fields: v.optional(
          v.array(v.object({ field: v.string(), weight: v.number() })),
        ),
      }),
    ),
    sortBy: v.optional(
      v.array(
        v.object({
          field: v.string(),
          order: v.union(v.literal("asc"), v.literal("desc")),
        }),
      ),
    ),
  },
  handler: async (ctx, args): Promise<SearchResult> => {
    const start = Date.now();
    const collection = await requireCollection(ctx, args.collection);

    const page = Math.max(1, Math.floor(args.page ?? 1));
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(args.perPage ?? 10)));

    const allDocs = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) => q.eq("collection", args.collection))
      .collect();
    const out_of = allDocs.length;
    const byId = new Map(allDocs.map((d) => [d.docId, d.stored]));

    const tokens = tokenize(args.q);
    const matchedTerms = new Set<string>();

    let matchedIds: string[];
    let scoreById: Map<string, number> | null = null;

    if (tokens.length === 0) {
      matchedIds = allDocs.map((d) => d.docId);
    } else {
      const perToken: Map<string, number>[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const candidates = await candidateTermsForToken(
          ctx,
          args.collection,
          tokens[i],
          i === tokens.length - 1,
        );
        for (const term of candidates.keys()) matchedTerms.add(term);
        perToken.push(
          await docScoresForToken(ctx, args.collection, candidates, args.queryBy),
        );
      }
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
      matchedIds = [...scoreById.keys()];
    }

    // Apply structured filter (in-memory over already-loaded stored docs).
    if (args.filterBy && args.filterBy.trim() !== "") {
      const fieldTypes: Record<string, "string" | "number"> = {};
      for (const f of collection.filterFields ?? []) fieldTypes[f.field] = f.type;
      const predicate = parseFilter(args.filterBy, fieldTypes);
      matchedIds = matchedIds.filter((id) =>
        predicate((byId.get(id) ?? {}) as Record<string, unknown>),
      );
    }

    const found = matchedIds.length;

    // Order: weighted/relevance score per doc, optional multi-key sort, docId tie-break.
    const rawScore = (id: string) => (scoreById ? (scoreById.get(id) ?? 0) : 0);
    const storedOf = (id: string) => (byId.get(id) ?? {}) as Record<string, unknown>;
    const orderScore = (id: string) =>
      orderingScore(rawScore(id), storedOf(id), args.rankBy);
    matchedIds.sort((a, b) =>
      compareMatches(a, b, { score: orderScore, stored: storedOf, sortBy: args.sortBy }),
    );

    // Faceting over the full (filtered) result set — query-scoped counts.
    const facet_counts: FacetCount[] = [];
    if (args.facetBy && args.facetBy.length > 0) {
      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
      for (const field of args.facetBy) {
        if (!declared.has(field)) {
          throw new Error(`Field "${field}" is not a declared facet field`);
        }
        const tally = new Map<string, number>();
        for (const id of matchedIds) {
          const raw = storedOf(id)[field];
          if (raw === undefined || raw === null) continue;
          const value = String(raw);
          tally.set(value, (tally.get(value) ?? 0) + 1);
        }
        const counts = [...tally.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .slice(0, maxValues)
          .map(([value, count]) => ({ value, count }));
        facet_counts.push({ field_name: field, counts });
      }
    }

    const pageIds = matchedIds.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
    const fields = args.queryBy ?? collection.searchFields;
    const hits: Hit[] = pageIds.map((id) => {
      const stored = storedOf(id);
      const highlight: Record<string, { snippet: string; matched_tokens: string[] }> = {};
      if (matchedTerms.size > 0) {
        for (const field of fields) {
          const value = stored[field];
          if (typeof value !== "string") continue;
          const h = highlightField(value, matchedTerms);
          if (h) highlight[field] = h;
        }
      }
      return { document: stored, highlight, text_match: rawScore(id) };
    });

    return {
      found,
      page,
      out_of,
      search_time_ms: Date.now() - start,
      hits,
      facet_counts,
    };
  },
});
