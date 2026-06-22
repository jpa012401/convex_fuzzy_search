import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import { highlightField } from "./highlight";
import { orderingScore, compareMatches } from "./ranking";
import { collectionCount, pageDocIds } from "./counters";
import { readFacetCounts } from "./facetCounts";
import { specMatches, canonicalSpecId, pageSortedDocIds, pageSortedDocIdsRange } from "./sortIndex";
import { evalTerms } from "./score";
import { searchResultValidator } from "./schema";
import type { SearchResult, Hit, FacetCount } from "./types";
import { resolveEqFilters, resolveRankProfile } from "./filterRank";
import { runTextQuery, runEmptyQFilterQuery, reverifyAnd, synthScore, clampK, orderCandidates, resolveFoundAndFacets, loadStored, suggestCorrectTokens, type Candidate } from "./searchRead";
import { assignSlots } from "./slotMap";

const MAX_PER_PAGE = 250;
const DEFAULT_RERANK_WINDOW = 200;
const MAX_RERANK_WINDOW = 1000;
const CUSTOM_ORDER_WINDOW = DEFAULT_RERANK_WINDOW;

// Tally facet counts over a candidate window. Count-desc then value-asc,
// capped at maxValues per field. Identical semantics used in two branches of
// the empty-q+filter path — extracted to avoid duplication.
function tallyFacetsOverCandidates(
  cands: Candidate[],
  facetBy: string[],
  declared: Set<string>,
  maxValues: number,
): FacetCount[] {
  const facet_counts: FacetCount[] = [];
  for (const field of facetBy) {
    if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
    const tally = new Map<string, number>();
    for (const cnd of cands) {
      const raw = cnd.stored[field];
      if (raw === undefined || raw === null) continue;
      tally.set(String(raw), (tally.get(String(raw)) ?? 0) + 1);
    }
    const counts = [...tally.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, maxValues)
      .map(([value, count]) => ({ value, count }));
    facet_counts.push({ field_name: field, counts });
  }
  return facet_counts;
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
  returns: searchResultValidator,
  handler: async (ctx, args): Promise<SearchResult> => {
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
    if (args.rank?.weights && rankProfile) {
      const termIds = new Set(rankProfile.terms.map((t) => t.id));
      for (const id of Object.keys(args.rank.weights)) {
        if (!termIds.has(id)) {
          throw new Error(`Unknown rank weight override "${id}" for profile "${args.rank.profile}"`);
        }
      }
    }
    const hasRank = !!rankProfile;
    const hasCustomOrder = hasSortBy || hasRankBy || hasRank;

    // ---- LEAN BROWSE: empty q, no filter/facets/custom order -> page off the aggregate.
    if (tokens.length === 0 && !hasFilter && !hasFacets && !hasCustomOrder) {
      const ids = await pageDocIds(ctx, args.collection, (page - 1) * perPage, perPage);
      const hits: Hit[] = ids.map((id) => ({ id, score: 0, highlight: {} }));
      return { found: out_of, found_approximate: false, reranked: true, page, out_of, hits, facet_counts: [] };
    }

    // ---- LEAN BROWSE + FACETS: empty q, no filter, no custom order -> page off
    // the aggregate and read facet counts from the write-maintained counters.
    if (tokens.length === 0 && !hasFilter && hasFacets && !hasCustomOrder) {
      const ids = await pageDocIds(ctx, args.collection, (page - 1) * perPage, perPage);
      const hits: Hit[] = ids.map((id) => ({ id, score: 0, highlight: {} }));
      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
      const facet_counts: FacetCount[] = [];
      for (const field of args.facetBy as string[]) {
        if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
        const counts = await readFacetCounts(ctx, args.collection, field, maxValues);
        facet_counts.push({ field_name: field, counts });
      }
      return { found: out_of, found_approximate: false, reranked: true, page, out_of, hits, facet_counts };
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
        const hits: Hit[] = ids.map((id) => ({ id, score: 0, highlight: {} }));
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
        return { found: out_of, found_approximate: false, reranked: true, page, out_of, hits, facet_counts };
      }
    }

    // ---- Derive field types for resolveEqFilters (needed by Task-8 paths).
    const fieldTypes: Record<string, "string" | "number"> = {};
    for (const f of collection.filterFields ?? []) fieldTypes[f.field] = f.type;
    const slotMap = collection.slotMap ?? assignSlots(collection);
    const window = Math.min(MAX_RERANK_WINDOW, Math.max(perPage, DEFAULT_RERANK_WINDOW));

    // ---- TEXT PATH: native OR retrieval -> app-side AND re-verify + rank/found/facets (F2/F3/F4/F5/F6).
    // NOTE: convex-test does NOT simulate native .searchIndex; this path is
    // asserted in the Task-12 smoke (npx convex run), not in vitest.
    if (tokens.length > 0) {
      const { eq, postFilter } = hasFilter
        ? resolveEqFilters(args.filterBy as string, slotMap, fieldTypes)
        : { eq: [], postFilter: null };
      const tq = await runTextQuery(
        ctx,
        { name: args.collection, searchFields: collection.searchFields },
        { q: args.q, queryBy: args.queryBy },
        slotMap,
        eq,
        window,
      );
      let candidates: Candidate[] = tq.candidates;
      if (postFilter) candidates = candidates.filter((c) => postFilter(c.stored));
      candidates = reverifyAnd(candidates, tokens);
      let found_approximate = tq.found_approximate;

      // ON-MISS TYPO CORRECTION (Task 15): if the AND-verified candidate set is
      // empty, attempt to correct each query token via the trigram dictionary and
      // re-run native search with the corrected query. Typo'd queries ("runing
      // shoe") are never sent to the index — correction fires on miss only.
      if (candidates.length === 0 && tokens.length > 0) {
        const correctedTokens = await suggestCorrectTokens(ctx, args.collection, tokens);
        if (correctedTokens !== null) {
          const correctedQ = correctedTokens.join(" ");
          const tqRetry = await runTextQuery(
            ctx,
            { name: args.collection, searchFields: collection.searchFields },
            { q: correctedQ, queryBy: args.queryBy },
            slotMap,
            eq,
            window,
          );
          let retryCandidates: Candidate[] = tqRetry.candidates;
          if (postFilter) retryCandidates = retryCandidates.filter((c) => postFilter(c.stored));
          candidates = reverifyAnd(retryCandidates, correctedTokens);
          if (tqRetry.found_approximate) found_approximate = true;
        }
      }

      const rankResolved = resolveRankProfile(collection, args.rank);
      const ordered = orderCandidates(candidates, {
        rank: rankResolved,
        rankBy: args.rankBy,
        sortBy: args.sortBy,
      });
      const total = ordered.length;

      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
      const ff = await resolveFoundAndFacets(ctx, args.collection, ordered, {
        queryPresent: tokens.length > 0,
        facetFields: hasFacets ? (args.facetBy as string[]) : [],
        declaredFacets: declared,
        maxFacetValues: maxValues,
        foundApproximate: found_approximate,
        browseOutOf: out_of,
      });
      const found = ff.found;
      let foundApprox = found_approximate;
      // If facets were tallied over the <=K window, signal via found_approximate.
      if (ff.facets_scoped) foundApprox = true;

      const pageStart = (page - 1) * perPage;
      const pageCands = ordered.slice(pageStart, pageStart + perPage);
      const fields = args.queryBy ?? collection.searchFields;
      const matchTermSet = new Set(tokens);
      const hits: Hit[] = pageCands.map((cnd) => {
        const highlight: Record<string, { snippet: string; matched_tokens: string[] }> = {};
        if (matchTermSet.size > 0) {
          for (const field of fields) {
            const value = cnd.stored[field];
            if (typeof value !== "string") continue;
            const h = highlightField(value, matchTermSet);
            if (h) highlight[field] = h;
          }
        }
        return { id: cnd.docId, score: synthScore(cnd.rankPos, total), highlight };
      });
      return {
        found,
        found_approximate: foundApprox,
        reranked: true,
        page,
        out_of,
        hits,
        facet_counts: ff.facet_counts,
      };
    }

    // ---- EMPTY-Q + FILTER path (F8): by_collection_doc scan + eq/postFilter,
    // bounded take. Deterministic + convex-test-runnable.
    // Handles ALL filter cases (with/without facets, with/without custom order).
    // For no-custom-order: runEmptyQFilterQuery + resolveFoundAndFacets covers everything.
    // For custom-order: same candidate retrieval, then re-rank in memory.
    if (tokens.length === 0 && hasFilter) {
      const { eq, postFilter } = resolveEqFilters(args.filterBy as string, slotMap, fieldTypes);
      const { candidates: cands, windowFull } = await runEmptyQFilterQuery(ctx, args.collection, eq, postFilter, clampK(window));
      const total = cands.length;

      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));

      if (!hasCustomOrder) {
        // No custom order: resolveFoundAndFacets handles found + facets.
        // queryPresent=false -> uses facetCounts TABLE for global facets;
        // but since we have a filter, tally over the candidate window instead.
        const facet_counts = hasFacets
          ? tallyFacetsOverCandidates(cands, args.facetBy as string[], declared, maxValues)
          : [];
        const ordered = [...cands].sort((a, b) => a.rankPos - b.rankPos);
        const pageStart = (page - 1) * perPage;
        const pageCands = ordered.slice(pageStart, pageStart + perPage);
        const hits: Hit[] = pageCands.map((c) => ({
          id: c.docId,
          score: synthScore(c.rankPos, total),
          highlight: {},
        }));
        return { found: total, found_approximate: windowFull, reranked: true, page, out_of, hits, facet_counts };
      }

      // Custom order (sortBy / rankBy / rank profile) over the filter candidates.
      const rankResolved = resolveRankProfile(collection, args.rank);
      let ordered: Candidate[];

      if (hasRank) {
        const windowSize = Math.min(MAX_RERANK_WINDOW, Math.max(1, Math.floor(rankProfile!.window ?? DEFAULT_RERANK_WINDOW)));
        const baseIdx = new Map(cands.map((c, i) => [c.docId, i]));
        const ctxRank = args.rank!.context ?? {};
        const rawScore = (cnd: Candidate) => synthScore(cnd.rankPos, total);
        const score = (cnd: Candidate) =>
          evalTerms(cnd.stored, rankProfile!.terms, args.rank!.weights, rawScore(cnd), ctxRank);
        const scored = [...cands].sort((a, b) => score(b) - score(a) || (baseIdx.get(a.docId)! - baseIdx.get(b.docId)!));
        ordered = scored.slice(0, windowSize);
      } else {
        ordered = orderCandidates(cands, {
          rank: rankResolved,
          rankBy: args.rankBy,
          sortBy: args.sortBy,
        });
      }

      // Facets over the full candidate set (before page windowing).
      const facet_counts = hasFacets
        ? tallyFacetsOverCandidates(cands, args.facetBy as string[], declared, maxValues)
        : [];

      const pageStart = (page - 1) * perPage;
      const pageCands = ordered.slice(pageStart, pageStart + perPage);
      const hits: Hit[] = pageCands.map((c) => ({
        id: c.docId,
        score: synthScore(c.rankPos, total),
        highlight: {},
      }));
      return { found: total, found_approximate: windowFull, reranked: true, page, out_of, hits, facet_counts };
    }

    // ---- RANK BROWSE: empty q, no filter, rank profile present.
    // Candidate window off the profile's base sortSpec (batched).
    if (hasRank) {
      const windowSize = Math.min(MAX_RERANK_WINDOW, Math.max(1, Math.floor(rankProfile!.window ?? DEFAULT_RERANK_WINDOW)));
      const baseIds = await pageSortedDocIdsRange(ctx, args.collection, rankProfile!.base, windowSize);
      const total = baseIds.length;
      let reranked = true;

      // Load stored docs for rank scoring.
      const storedMap = new Map<string, Record<string, unknown>>();
      await Promise.all(baseIds.map(async (id) => {
        storedMap.set(id, await loadStored(ctx, args.collection, id));
      }));
      const storedOf = (id: string) => storedMap.get(id) ?? {};

      const ctxRank = args.rank!.context ?? {};
      const rawScore = (id: string, rankPos: number) => synthScore(rankPos, total);
      const score = (id: string, rankPos: number) =>
        evalTerms(storedOf(id), rankProfile!.terms, args.rank!.weights, rawScore(id, rankPos), ctxRank);

      // Score the window.
      const baseIdx = new Map(baseIds.map((id, i) => [id, i]));
      let scoredIds = [...baseIds].sort((a, b) => {
        const ai = baseIdx.get(a)!;
        const bi = baseIdx.get(b)!;
        return score(b, bi) - score(a, ai) || (ai - bi);
      });
      if (scoredIds.length > windowSize) {
        scoredIds = scoredIds.slice(0, windowSize);
        reranked = false;
      }

      // Facets (global from facetCounts TABLE since no filter).
      const facet_counts: FacetCount[] = [];
      if (hasFacets) {
        const declared = new Set(collection.facetFields ?? []);
        const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
        for (const field of args.facetBy as string[]) {
          if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
          facet_counts.push({ field_name: field, counts: await readFacetCounts(ctx, args.collection, field, maxValues) });
        }
      }

      const pageStart = (page - 1) * perPage;
      let pageIds: string[];
      const windowPart = scoredIds.slice(pageStart, pageStart + perPage);
      if (pageStart + perPage > scoredIds.length) {
        // Page extends past the re-ranked window -> fill from plain base order.
        const tailStart = Math.max(pageStart, scoredIds.length);
        const need = perPage - windowPart.length;
        const tail = need > 0
          ? await pageSortedDocIds(ctx, args.collection, rankProfile!.base, tailStart, need)
          : [];
        if (tail.length > 0) {
          await Promise.all(tail.map(async (id) => {
            if (!storedMap.has(id)) storedMap.set(id, await loadStored(ctx, args.collection, id));
          }));
          reranked = false;
        }
        pageIds = [...windowPart, ...tail];
      } else {
        pageIds = windowPart;
      }

      const hits: Hit[] = pageIds.map((id) => ({
        id,
        score: 0,
        highlight: {},
      }));
      return { found: out_of, found_approximate: false, reranked, page, out_of, hits, facet_counts };
    }

    // ---- BROWSE + custom-order but NO filter, NO rank profile:
    // rankBy or sortBy over a bounded aggregate window.
    {
      const windowIds = await pageDocIds(ctx, args.collection, 0, CUSTOM_ORDER_WINDOW);
      const windowTruncated = out_of > windowIds.length;

      // Load stored docs for ordering.
      const storedMap = new Map<string, Record<string, unknown>>();
      await Promise.all(windowIds.map(async (id) => {
        storedMap.set(id, await loadStored(ctx, args.collection, id));
      }));
      const storedOf = (id: string) => storedMap.get(id) ?? {};

      const total = windowIds.length;
      const cands: Candidate[] = windowIds.map((id, i) => ({
        docId: id,
        stored: storedOf(id),
        slotText: "",
        rankPos: i,
      }));

      const ordered = orderCandidates(cands, {
        rankBy: args.rankBy,
        sortBy: args.sortBy,
      });

      // Facets (global from facetCounts TABLE since no filter).
      const facet_counts: FacetCount[] = [];
      if (hasFacets) {
        const declared = new Set(collection.facetFields ?? []);
        const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
        for (const field of args.facetBy as string[]) {
          if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
          facet_counts.push({ field_name: field, counts: await readFacetCounts(ctx, args.collection, field, maxValues) });
        }
      }

      const pageStart = (page - 1) * perPage;
      const pageCands = ordered.slice(pageStart, pageStart + perPage);
      const hits: Hit[] = pageCands.map((c) => ({
        id: c.docId,
        score: synthScore(c.rankPos, total),
        highlight: {},
      }));
      return {
        found: windowTruncated ? out_of : total,
        found_approximate: windowTruncated,
        reranked: true,
        page,
        out_of,
        hits,
        facet_counts,
      };
    }
  },
});
