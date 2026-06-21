import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import { matchTokens } from "./textSearch";
import { loadDocumentByDocKey } from "./docKeys";
import { parseFilterAst, resolveAstToDocIds } from "./filter";
import { highlightField } from "./highlight";
import { orderingScore, compareMatches } from "./ranking";
import { collectionCount, pageDocIds } from "./counters";
import { readFacetCounts, facetValuesForField } from "./facetCounts";
import { readFacetPostingDocKeys } from "./facetPostings";
import { specMatches, canonicalSpecId, pageSortedDocIds, pageSortedDocIdsRange } from "./sortIndex";
import { evalTerms } from "./score";
import { searchResultValidator } from "./schema";
import type { SearchResult, Hit, FacetCount } from "./types";
import { resolveEqFilters, resolveRankProfile } from "./filterRank";
import { runTextQuery, runEmptyQFilterQuery, reverifyAnd, synthScore, clampK, orderCandidates, resolveFoundAndFacets, type Candidate } from "./searchRead";
import { assignSlots } from "./slotMap";

const MAX_PER_PAGE = 250;
const DEFAULT_RERANK_WINDOW = 200;
const MAX_RERANK_WINDOW = 1000;
const CUSTOM_ORDER_WINDOW = DEFAULT_RERANK_WINDOW;

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
      const found_approximate = tq.found_approximate;

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
    // Only handles the no-custom-order, no-facets case; others fall through to
    // the legacy branches below (rank-browse, browse+custom remain intact).
    if (tokens.length === 0 && hasFilter && !hasCustomOrder && !hasFacets) {
      const { eq, postFilter } = resolveEqFilters(args.filterBy as string, slotMap, fieldTypes);
      const cands = await runEmptyQFilterQuery(ctx, args.collection, eq, postFilter, clampK(window));
      const total = cands.length;
      const found = total;
      const pageStart = (page - 1) * perPage;
      const ordered = [...cands].sort((a, b) => a.rankPos - b.rankPos);
      const pageCands = ordered.slice(pageStart, pageStart + perPage);
      const hits: Hit[] = pageCands.map((c) => ({
        id: c.docId,
        score: synthScore(c.rankPos, total),
        highlight: {},
      }));
      return { found, found_approximate: false, reranked: true, page, out_of, hits, facet_counts: [] };
    }

    // ---- Resolve filter to a docKey set via the bucketed index, if present.
    let filterDocKeys: Set<number> | null = null;
    let filterComplete = false;
    let filterTruncated = false;
    if (hasFilter) {
      const pendingFilter = new Set(
        (collection.pendingFields ?? []).filter((f) =>
          (collection.filterFields ?? []).some((ff) => ff.field === f)),
      );
      const resolved = await resolveAstToDocIds(
        ctx,
        args.collection,
        parseFilterAst(args.filterBy as string, fieldTypes),
        undefined,
        pendingFilter,
      );
      filterDocKeys = resolved.docKeys;
      filterComplete = resolved.complete;
      filterTruncated = resolved.truncated;
    }
    // The full matched count (before paging). The page-only filter branch loads
    // only one page of docs, so `matchedIds.length` is NOT the total — use this.
    const filterMatchCount = filterDocKeys ? filterDocKeys.size : null;

    // ---- Build the working set (byId) + match ids + scores.
    let matchedIds: string[];
    let scoreById: Map<string, number> | null = null;
    const matchedTerms = new Set<string>();
    let byId: Map<string, unknown>;
    let truncated = false;
    let windowTruncated = false;
    let singleExactTerm: string | null = null;
    let reranked = true;
    let deferredPageLoad = false;
    // The filter-only page-only branch resolves docIds for just this page (in
    // docKey order), so `matchedIds` already IS the page — the downstream page
    // slice must take it whole rather than re-slicing at pageStart.
    let filterPageOnly = false;

    if (tokens.length > 0) {
      // TEXT PATH: driver-token intersection (bounded). The filter docKeys are
      // intersected INSIDE matchTokens (before its docId resolution), so
      // scoreById comes back already narrowed to docs matching BOTH.
      const m = await matchTokens(
        ctx,
        args.collection,
        tokens,
        args.queryBy,
        undefined,
        filterDocKeys ?? undefined,
      );
      scoreById = m.scoreById;
      for (const term of m.matchedTerms) matchedTerms.add(term);
      truncated = m.truncated;
      singleExactTerm = m.singleExactTerm;
      matchedIds = [...scoreById.keys()];
      // Only facet tallying and stored-field ordering (rankBy/sortBy/rank) need
      // the WHOLE matched set's stored docs. Plain relevance-ordered text search
      // needs stored docs for the page only (highlighting), and orders by the
      // relevance score alone — so defer to a bounded page-load below and avoid
      // loading every matched doc (which can exceed the per-query read limit).
      if (hasFacets || hasCustomOrder) {
        byId = await loadDocs(ctx, args.collection, matchedIds);
      } else {
        byId = new Map<string, unknown>();
        deferredPageLoad = true;
      }
    } else if (filterDocKeys) {
      // FILTER-ONLY PATH: work in docKeys; resolve docIds only for the docs we
      // actually need. Facets via the inverted index need no docs; only custom
      // ordering (or a facet request that can't use the index) needs the full set.
      const keys = [...filterDocKeys].sort((a, b) => a - b);
      const facetsNeedDocs = hasFacets && !(filterDocKeys && filterComplete);
      byId = new Map<string, unknown>();
      matchedIds = [];
      if (!facetsNeedDocs && !hasCustomOrder) {
        // page-only: map just this page's docKeys -> documents. matchedIds then
        // holds only this page (in docKey order), so flag it for the page slice.
        filterPageOnly = true;
        const pageStart = (page - 1) * perPage;
        const pageKeys = keys.slice(pageStart, pageStart + perPage);
        const rows = await Promise.all(
          pageKeys.map((k) => loadDocumentByDocKey(ctx, args.collection, k)),
        );
        for (const row of rows) {
          if (!row) continue;
          matchedIds.push(row.docId);
          byId.set(row.docId, row.stored);
        }
        // `found` is the full matched set (filterMatchCount), not just the page.
      } else {
        // map ALL matched docKeys -> documents (for facet tally / custom order).
        const rows = await Promise.all(
          keys.map((k) => loadDocumentByDocKey(ctx, args.collection, k)),
        );
        for (const row of rows) {
          if (!row) continue;
          matchedIds.push(row.docId);
          byId.set(row.docId, row.stored);
        }
      }
    } else if (hasRank) {
      // RANK BROWSE: candidate window off the profile's base sortSpec (batched).
      const windowSize = Math.min(MAX_RERANK_WINDOW, Math.max(1, Math.floor(rankProfile!.window ?? DEFAULT_RERANK_WINDOW)));
      matchedIds = await pageSortedDocIdsRange(ctx, args.collection, rankProfile!.base, windowSize);
      byId = await loadDocs(ctx, args.collection, matchedIds);
    } else {
      // BROWSE + custom-order but NO filter: rank a bounded aggregate window
      // instead of loading the whole collection before pagination.
      matchedIds = await pageDocIds(ctx, args.collection, 0, CUSTOM_ORDER_WINDOW);
      windowTruncated = out_of > matchedIds.length;
      byId = await loadDocs(ctx, args.collection, matchedIds);
    }

    const storedOf = (id: string) => (byId.get(id) ?? {}) as Record<string, unknown>;

    // `found` is the materialized-candidate count. When `found_approximate` is
    // true (driver scan truncated), it is a FLOOR, not the exact total — only
    // the single-exact-term / no-filter / no-queryBy case is corrected to the
    // exact terms.docCount below.
    // The filter-only branch may put only one page in matchedIds; report the
    // FULL filter match count instead. The text path's matchedIds is already the
    // complete text∩filter set, so it must use matchedIds.length (not the full
    // filter size). Hence only override `found` when there is no text query.
    let found =
      tokens.length === 0 && filterMatchCount !== null
        ? filterMatchCount
        : matchedIds.length;
    let found_approximate = filterTruncated || windowTruncated;
    if (truncated) {
      found_approximate = true;
      // terms.docCount counts the term across ALL searchFields, so it is only an
      // exact total when the query is not narrowed by a filter or queryBy.
      if (singleExactTerm && !filterDocKeys && !args.queryBy) {
        const termRow = await ctx.db
          .query("terms")
          .withIndex("by_collection_term", (q) =>
            q.eq("collection", args.collection).eq("term", singleExactTerm as string),
          )
          .unique();
        if (termRow) found = termRow.docCount;
      }
    }
    if (hasRank && tokens.length === 0 && !filterDocKeys) {
      found = out_of;
    }
    if (windowTruncated && tokens.length === 0 && !filterDocKeys) {
      found = out_of;
    }

    const facetIds = matchedIds; // full matched/candidate set, before any rank windowing
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
    } else if (!filterPageOnly) {
      // filterPageOnly already holds the page in docKey order; re-sorting it here
      // would scramble that page-local order (and only the page is loaded), so skip.
      const orderScore = (id: string) => orderingScore(rawScore(id), storedOf(id), args.rankBy);
      matchedIds.sort((a, b) =>
        compareMatches(a, b, { score: orderScore, stored: storedOf, sortBy: args.sortBy }),
      );
    }

    const facet_counts: FacetCount[] = [];
    if (hasFacets) {
      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
      const globalFacets = hasRank && tokens.length === 0 && !filterDocKeys;
      for (const field of args.facetBy as string[]) {
        if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
        if (globalFacets) {
          facet_counts.push({ field_name: field, counts: await readFacetCounts(ctx, args.collection, field, maxValues) });
          continue;
        }
        if (tokens.length === 0 && filterDocKeys && filterComplete) {
          const values = await facetValuesForField(ctx, args.collection, field);
          const counts: { value: string; count: number }[] = [];
          for (const value of values) {
            const postArr = await readFacetPostingDocKeys(ctx, args.collection, field, value);
            const post = new Set<number>(postArr);
            const [small, big] = post.size <= filterDocKeys.size ? [post, filterDocKeys] : [filterDocKeys, post];
            let n = 0;
            for (const k of small) if (big.has(k)) n++;
            if (n > 0) counts.push({ value, count: n });
          }
          counts.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
          facet_counts.push({ field_name: field, counts: counts.slice(0, maxValues) });
          continue;
        }
        const tally = new Map<string, number>();
        for (const id of facetIds) {
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
    let pageIds: string[];
    if (hasRank && tokens.length === 0 && !filterDocKeys) {
      const windowPart = matchedIds.slice(pageStart, pageStart + perPage);
      if (pageStart + perPage > matchedIds.length) {
        // page extends past the re-ranked window -> fill from plain base order
        const tailStart = Math.max(pageStart, matchedIds.length);
        const need = perPage - windowPart.length;
        const tail = need > 0
          ? await pageSortedDocIds(ctx, args.collection, rankProfile!.base, tailStart, need)
          : [];
        if (tail.length > 0) {
          const tailById = await loadDocs(ctx, args.collection, tail);
          for (const [k, val] of tailById) byId.set(k, val);
          reranked = false;
        }
        pageIds = [...windowPart, ...tail];
      } else {
        pageIds = windowPart;
      }
    } else if (filterPageOnly) {
      // matchedIds already IS this page (loaded at pageStart in docKey order).
      pageIds = matchedIds;
    } else {
      pageIds = matchedIds.slice(pageStart, pageStart + perPage);
    }
    // Deferred page-load: the text path with no facets/custom order skipped the
    // full matched-set load above; fetch just this page's stored docs now (for
    // highlighting). byId is otherwise already populated.
    if (deferredPageLoad && pageIds.length > 0) {
      byId = await loadDocs(ctx, args.collection, pageIds);
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
      return { id, score: rawScore(id), highlight };
    });

    return { found, found_approximate, reranked, page, out_of, hits, facet_counts };
  },
});
