import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import type { SearchResult, Hit } from "./types";

const MAX_PER_PAGE = 250;

async function docIdsForToken(
  ctx: QueryCtx,
  collection: string,
  term: string,
  queryBy: string[] | undefined,
): Promise<Set<string>> {
  const rows = await ctx.db
    .query("postings")
    .withIndex("by_collection_term", (q) =>
      q.eq("collection", collection).eq("term", term),
    )
    .collect();
  const ids = new Set<string>();
  for (const r of rows) {
    if (queryBy && !queryBy.includes(r.field)) continue;
    ids.add(r.docId);
  }
  return ids;
}

function intersect(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  sets.sort((a, b) => a.size - b.size);
  const [first, ...rest] = sets;
  const out = new Set<string>();
  for (const id of first) {
    if (rest.every((s) => s.has(id))) out.add(id);
  }
  return out;
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
    if (tokens.length === 0) {
      matchedIds = allDocs.map((d) => d.docId);
    } else {
      const sets: Set<string>[] = [];
      for (const tok of tokens) {
        sets.push(await docIdsForToken(ctx, args.collection, tok, args.queryBy));
      }
      matchedIds = [...intersect(sets)];
    }

    matchedIds.sort();
    const found = matchedIds.length;

    const pageIds = matchedIds.slice((page - 1) * perPage, (page - 1) * perPage + perPage);

    const byId = new Map(allDocs.map((d) => [d.docId, d.stored]));
    const hits: Hit[] = pageIds.map((id) => ({
      document: (byId.get(id) ?? {}) as Record<string, unknown>,
      highlight: {},
      text_match: 0,
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
