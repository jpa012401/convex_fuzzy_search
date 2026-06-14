import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import { candidateTermsForToken } from "./matching";
import { parseFilterAst, resolveAstToDocIds } from "./filter";
import { highlightField } from "./highlight";
import { orderingScore, compareMatches } from "./ranking";
import { collectionCount, pageDocIds } from "./counters";
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

// Load only the named docs (bounded by ids.length, not the collection).
async function loadDocs(
  ctx: QueryCtx,
  collection: string,
  ids: string[],
): Promise<Map<string, unknown>> {
  const byId = new Map<string, unknown>();
  for (const id of ids) {
    const row = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) =>
        q.eq("collection", collection).eq("docId", id),
      )
      .unique();
    if (row) byId.set(id, row.stored);
  }
  return byId;
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
        fields: v.optional(v.array(v.object({ field: v.string(), weight: v.number() }))),
      }),
    ),
    sortBy: v.optional(
      v.array(v.object({ field: v.string(), order: v.union(v.literal("asc"), v.literal("desc")) })),
    ),
  },
  handler: async (ctx, args): Promise<SearchResult> => {
    const start = Date.now();
    const collection = await requireCollection(ctx, args.collection);
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(args.perPage ?? 10)));
    const out_of = await collectionCount(ctx, args.collection);

    const tokens = tokenize(args.q);
    const hasFilter = !!(args.filterBy && args.filterBy.trim() !== "");
    const hasFacets = !!(args.facetBy && args.facetBy.length > 0);
    const hasCustomOrder =
      (!!args.sortBy && args.sortBy.length > 0) ||
      (!!args.rankBy && ((args.rankBy.fields?.length ?? 0) > 0 || args.rankBy.text !== undefined));

    // ---- LEAN BROWSE: empty q, no filter/facets/custom order -> page off the aggregate.
    if (tokens.length === 0 && !hasFilter && !hasFacets && !hasCustomOrder) {
      const ids = await pageDocIds(ctx, args.collection, (page - 1) * perPage, perPage);
      const byId = await loadDocs(ctx, args.collection, ids);
      const hits: Hit[] = ids.map((id) => ({
        document: (byId.get(id) ?? {}) as Record<string, unknown>,
        highlight: {},
        text_match: 0,
      }));
      return { found: out_of, page, out_of, search_time_ms: Date.now() - start, hits, facet_counts: [] };
    }

    // ---- Resolve filter to a docId set via the index (S2), if present.
    let filterIds: Set<string> | null = null;
    if (hasFilter) {
      const fieldTypes: Record<string, "string" | "number"> = {};
      for (const f of collection.filterFields ?? []) fieldTypes[f.field] = f.type;
      filterIds = await resolveAstToDocIds(
        ctx,
        args.collection,
        parseFilterAst(args.filterBy as string, fieldTypes),
      );
    }

    // ---- Build the working set (byId) + match ids + scores.
    let matchedIds: string[];
    let scoreById: Map<string, number> | null = null;
    const matchedTerms = new Set<string>();
    let byId: Map<string, unknown>;

    if (tokens.length > 0) {
      // TEXT PATH: candidate set from postings; intersect with filter; load only those docs.
      const perToken: Map<string, number>[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const candidates = await candidateTermsForToken(ctx, args.collection, tokens[i], i === tokens.length - 1);
        for (const term of candidates.keys()) matchedTerms.add(term);
        perToken.push(await docScoresForToken(ctx, args.collection, candidates, args.queryBy));
      }
      perToken.sort((a, b) => a.size - b.size);
      const [first, ...rest] = perToken;
      scoreById = new Map();
      if (first) {
        for (const [docId, s0] of first) {
          if (rest.every((m) => m.has(docId))) {
            let total = s0;
            for (const m of rest) total += m.get(docId)!;
            scoreById.set(docId, total);
          }
        }
      }
      matchedIds = [...scoreById.keys()];
      if (filterIds) matchedIds = matchedIds.filter((id) => filterIds!.has(id));
      byId = await loadDocs(ctx, args.collection, matchedIds);
    } else if (filterIds) {
      // BROWSE + FILTER: the filter set is the result set (no full-collection load).
      matchedIds = [...filterIds];
      byId = await loadDocs(ctx, args.collection, matchedIds);
    } else {
      // BROWSE + facets/custom-order but NO filter: still full load (S3/S4 replace this).
      const allDocs = await ctx.db
        .query("documents")
        .withIndex("by_collection_doc", (q) => q.eq("collection", args.collection))
        .collect();
      byId = new Map(allDocs.map((d) => [d.docId, d.stored]));
      matchedIds = allDocs.map((d) => d.docId);
    }

    const storedOf = (id: string) => (byId.get(id) ?? {}) as Record<string, unknown>;

    const found = matchedIds.length;

    const rawScore = (id: string) => (scoreById ? (scoreById.get(id) ?? 0) : 0);
    const orderScore = (id: string) => orderingScore(rawScore(id), storedOf(id), args.rankBy);
    matchedIds.sort((a, b) =>
      compareMatches(a, b, { score: orderScore, stored: storedOf, sortBy: args.sortBy }),
    );

    const facet_counts: FacetCount[] = [];
    if (hasFacets) {
      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
      for (const field of args.facetBy as string[]) {
        if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
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

    return { found, page, out_of, search_time_ms: Date.now() - start, hits, facet_counts };
  },
});
