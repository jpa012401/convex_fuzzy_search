import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import { matchTokens } from "./textSearch";
import { parseFilterAst, resolveAstToDocIds } from "./filter";
import { highlightField } from "./highlight";
import { orderingScore, compareMatches } from "./ranking";
import { collectionCount, pageDocIds } from "./counters";
import { readFacetCounts } from "./facetCounts";
import { specMatches, canonicalSpecId, pageSortedDocIds, pageSortedDocIdsRange } from "./sortIndex";
import { evalTerms } from "./score";
import type { SearchResult, Hit, FacetCount } from "./types";

const MAX_PER_PAGE = 250;
const DEFAULT_RERANK_WINDOW = 200;
const MAX_RERANK_WINDOW = 1000;

// Load only the named docs (bounded by ids.length, not the collection).
async function loadDocs(
  ctx: QueryCtx,
  collection: string,
  ids: string[],
): Promise<Map<string, unknown>> {
  const byId = new Map<string, unknown>();
  const rows = await Promise.all(
    ids.map((id) =>
      ctx.db
        .query("documents")
        .withIndex("by_collection_doc", (q) =>
          q.eq("collection", collection).eq("docId", id),
        )
        .unique(),
    ),
  );
  rows.forEach((row, i) => {
    if (row) byId.set(ids[i], row.stored);
  });
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
    rank: v.optional(
      v.object({
        profile: v.string(),
        weights: v.optional(v.record(v.string(), v.number())),
        context: v.optional(
          v.object({
            now: v.optional(v.number()),
            origin: v.optional(v.object({ lat: v.number(), lng: v.number() })),
            sets: v.optional(v.record(v.string(), v.array(v.string()))),
          }),
        ),
      }),
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
    const hasSortBy = !!args.sortBy && args.sortBy.length > 0;
    const hasRankBy =
      !!args.rankBy && ((args.rankBy.fields?.length ?? 0) > 0 || args.rankBy.text !== undefined);
    const rankProfile = args.rank ? collection.rankProfiles?.[args.rank.profile] : undefined;
    if (args.rank && !rankProfile) {
      throw new Error(`Unknown rank profile "${args.rank.profile}"`);
    }
    const hasRank = !!rankProfile;
    const hasCustomOrder = hasSortBy || hasRankBy || hasRank;

    // ---- LEAN BROWSE: empty q, no filter/facets/custom order -> page off the aggregate.
    if (tokens.length === 0 && !hasFilter && !hasFacets && !hasCustomOrder) {
      const ids = await pageDocIds(ctx, args.collection, (page - 1) * perPage, perPage);
      const byId = await loadDocs(ctx, args.collection, ids);
      const hits: Hit[] = ids.map((id) => ({
        document: (byId.get(id) ?? {}) as Record<string, unknown>,
        highlight: {},
        text_match: 0,
      }));
      return { found: out_of, found_approximate: false, reranked: true, page, out_of, search_time_ms: Date.now() - start, hits, facet_counts: [] };
    }

    // ---- LEAN BROWSE + FACETS: empty q, no filter, no custom order -> page off
    // the aggregate and read facet counts from the write-maintained counters.
    if (tokens.length === 0 && !hasFilter && hasFacets && !hasCustomOrder) {
      const ids = await pageDocIds(ctx, args.collection, (page - 1) * perPage, perPage);
      const byId = await loadDocs(ctx, args.collection, ids);
      const hits: Hit[] = ids.map((id) => ({
        document: (byId.get(id) ?? {}) as Record<string, unknown>,
        highlight: {},
        text_match: 0,
      }));
      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
      const facet_counts: FacetCount[] = [];
      for (const field of args.facetBy as string[]) {
        if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
        const counts = await readFacetCounts(ctx, args.collection, field, maxValues);
        facet_counts.push({ field_name: field, counts });
      }
      return { found: out_of, found_approximate: false, reranked: true, page, out_of, search_time_ms: Date.now() - start, hits, facet_counts };
    }

    // ---- LEAN BROWSE + SORT: empty q, no filter, no rankBy, and sortBy matches
    // a declared spec -> page off the sort-index aggregate (no full-collection load).
    // found is out_of (every doc is indexed per spec); before the sort-index
    // backfill runs for a pre-S4 collection it may exceed the indexed entries,
    // so the final page can be short until backfill completes.
    if (tokens.length === 0 && !hasFilter && hasSortBy && !hasRankBy && !hasRank) {
      const spec = specMatches(args.sortBy, collection.sortSpecs ?? []);
      if (spec) {
        const ids = await pageSortedDocIds(
          ctx,
          args.collection,
          canonicalSpecId(spec),
          (page - 1) * perPage,
          perPage,
        );
        const byId = await loadDocs(ctx, args.collection, ids);
        const hits: Hit[] = ids.map((id) => ({
          document: (byId.get(id) ?? {}) as Record<string, unknown>,
          highlight: {},
          text_match: 0,
        }));
        const facet_counts: FacetCount[] = [];
        if (hasFacets) {
          const declared = new Set(collection.facetFields ?? []);
          const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
          for (const field of args.facetBy as string[]) {
            if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
            const counts = await readFacetCounts(ctx, args.collection, field, maxValues);
            facet_counts.push({ field_name: field, counts });
          }
        }
        return { found: out_of, found_approximate: false, reranked: true, page, out_of, search_time_ms: Date.now() - start, hits, facet_counts };
      }
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
    let truncated = false;
    let singleExactTerm: string | null = null;
    let reranked = true;

    if (tokens.length > 0) {
      // TEXT PATH: driver-token intersection (bounded). Intersect with filter; load only matched docs.
      const m = await matchTokens(ctx, args.collection, tokens, args.queryBy);
      scoreById = m.scoreById;
      for (const term of m.matchedTerms) matchedTerms.add(term);
      truncated = m.truncated;
      singleExactTerm = m.singleExactTerm;
      matchedIds = [...scoreById.keys()];
      if (filterIds) matchedIds = matchedIds.filter((id) => filterIds!.has(id));
      byId = await loadDocs(ctx, args.collection, matchedIds);
    } else if (filterIds) {
      // BROWSE + FILTER: the filter set is the result set (no full-collection load).
      matchedIds = [...filterIds];
      byId = await loadDocs(ctx, args.collection, matchedIds);
    } else if (hasRank) {
      // RANK BROWSE: candidate window off the profile's base sortSpec (batched).
      const windowSize = Math.min(MAX_RERANK_WINDOW, Math.max(1, Math.floor(rankProfile!.window ?? DEFAULT_RERANK_WINDOW)));
      matchedIds = await pageSortedDocIdsRange(ctx, args.collection, rankProfile!.base, windowSize);
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

    let found = matchedIds.length;
    let found_approximate = false;
    if (truncated) {
      found_approximate = true;
      // terms.docCount counts the term across ALL searchFields, so it is only an
      // exact total when the query is not narrowed by a filter or queryBy.
      if (singleExactTerm && !filterIds && !args.queryBy) {
        const termRow = await ctx.db
          .query("terms")
          .withIndex("by_collection_term", (q) =>
            q.eq("collection", args.collection).eq("term", singleExactTerm as string),
          )
          .unique();
        if (termRow) found = termRow.docCount;
      }
    }
    if (hasRank && tokens.length === 0 && !filterIds) {
      found = out_of;
    }

    const rawScore = (id: string) => (scoreById ? (scoreById.get(id) ?? 0) : 0);
    if (hasRank) {
      const windowSize = Math.min(MAX_RERANK_WINDOW, Math.max(1, Math.floor(rankProfile!.window ?? DEFAULT_RERANK_WINDOW)));
      // Order before windowing: browse = base order (already), text = relevance desc,
      // filter-only = arbitrary matched-set order.
      let ordered = matchedIds;
      if (tokens.length > 0) {
        ordered = [...matchedIds].sort((a, b) => rawScore(b) - rawScore(a) || (a < b ? -1 : a > b ? 1 : 0));
      }
      if (ordered.length > windowSize) {
        ordered = ordered.slice(0, windowSize);
        reranked = false;
      }
      const baseIdx = new Map(ordered.map((id, i) => [id, i]));
      const ctxRank = args.rank!.context ?? {};
      const score = (id: string) =>
        evalTerms(storedOf(id), rankProfile!.terms, args.rank!.weights, rawScore(id), ctxRank);
      matchedIds = [...ordered].sort((a, b) => score(b) - score(a) || (baseIdx.get(a)! - baseIdx.get(b)!));
    } else {
      const orderScore = (id: string) => orderingScore(rawScore(id), storedOf(id), args.rankBy);
      matchedIds.sort((a, b) =>
        compareMatches(a, b, { score: orderScore, stored: storedOf, sortBy: args.sortBy }),
      );
    }

    const facet_counts: FacetCount[] = [];
    if (hasFacets) {
      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
      const globalFacets = hasRank && tokens.length === 0 && !filterIds;
      for (const field of args.facetBy as string[]) {
        if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
        if (globalFacets) {
          facet_counts.push({ field_name: field, counts: await readFacetCounts(ctx, args.collection, field, maxValues) });
          continue;
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

    const pageStart = (page - 1) * perPage;
    const rerankWindow = Math.min(MAX_RERANK_WINDOW, Math.max(1, Math.floor(rankProfile?.window ?? DEFAULT_RERANK_WINDOW)));
    let pageIds: string[];
    if (hasRank && tokens.length === 0 && !filterIds && pageStart >= rerankWindow) {
      // Beyond the re-ranked window: serve the plain base order (head-only re-rank).
      pageIds = await pageSortedDocIds(ctx, args.collection, rankProfile!.base, pageStart, perPage);
      const tailById = await loadDocs(ctx, args.collection, pageIds);
      for (const [k, val] of tailById) byId.set(k, val);
      reranked = false;
    } else {
      pageIds = matchedIds.slice(pageStart, pageStart + perPage);
    }
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

    return { found, found_approximate, reranked, page, out_of, search_time_ms: Date.now() - start, hits, facet_counts };
  },
});
