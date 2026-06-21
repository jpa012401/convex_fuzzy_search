/**
 * SMOKE TEST — throwaway functions for Task 12 real-deployment validation.
 *
 * These are NOT unit tests. They drive the FuzzySearch client against the live
 * Convex deployment via `npx convex run` to verify native .searchIndex
 * behaviors that convex-test cannot simulate (OR-semantics, 1024 cap, sync-at-
 * commit indexing).
 *
 * Commands run and VERBATIM output (recorded after Step 7):
 *
 *   npx convex run smoke:reset
 *   npx convex run smoke:sameTxnSearchable '{"id":"smoke-1","title":"zephyrine"}'
 *   npx convex run smoke:seedCommon '{"n":3000,"term":"widget"}'
 *   npx convex run smoke:commonSearch '{"term":"widget","perPage":25}'
 *   npx convex run smoke:commonSearch '{"term":"widget","perPage":10}'
 *   npx convex run smoke:collectionStats
 *   npx convex run smoke:reset   (Step 6 deleteCollection + recreate)
 *   npx convex run smoke:collectionStats   (Step 6 post-reset check)
 *
 * (Output filled in after live run — see task-12-report.md)
 */

import { internalMutation, internalQuery } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { FuzzySearch } from "@elevatech/fuzzy-search";

const search = new FuzzySearch(components.fuzzySearch);
const COLLECTION = "smoke";

// Recreate the collection fresh so the smoke run is idempotent.
export const reset = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await search.getCollection(ctx, COLLECTION);
    if (existing) await search.deleteCollection(ctx, COLLECTION);
    await search.createCollection(ctx, {
      name: COLLECTION,
      searchFields: ["title", "body"],
      storedFields: "all",
      filterFields: [{ field: "brand", type: "string" }, { field: "price", type: "number" }],
      facetFields: ["brand"],
    });
    return { ok: true };
  },
});

// Upsert one doc, then in the SAME transaction search for it: native
// .searchIndex is synchronous at commit, so it must already be findable.
export const sameTxnSearchable = internalMutation({
  args: { id: v.string(), title: v.string() },
  handler: async (ctx, { id, title }) => {
    await search.upsert(ctx, { collection: COLLECTION, id, doc: { title, body: "smoke body", brand: "Acme", price: 10 } });
    const r = await search.search(ctx, { collection: COLLECTION, q: title, perPage: 5 });
    const found = r.hits.some((h) => h.id === id);
    return { found, hitIds: r.hits.map((h) => h.id) };
  },
});

// Seed N docs starting at offset that all share a common term, to exercise the
// bounded page + no-throw guarantee on a high-frequency query.
// Call multiple times with different offsets to build up 3000+ total docs.
// e.g.: seedCommon n=50 offset=0, seedCommon n=50 offset=50, ... (60 calls to get 3000)
export const seedCommon = internalMutation({
  args: { n: v.number(), term: v.string(), offset: v.optional(v.number()) },
  handler: async (ctx, { n, term, offset: startOffset = 0 }) => {
    const BATCH = 50; // upsertMany accepts at most 50 docs per call
    for (let start = 0; start < n; start += BATCH) {
      const docs = Array.from({ length: Math.min(BATCH, n - start) }, (_, i) => {
        const k = startOffset + start + i;
        return { id: `c${String(k).padStart(7, "0")}`, doc: { title: `${term} item ${k}`, body: "x", brand: k % 2 ? "Acme" : "Globex", price: k } };
      });
      await search.upsertMany(ctx, { collection: COLLECTION, docs });
    }
    return { seeded: n, from: startOffset };
  },
});

export const commonSearch = internalQuery({
  args: { term: v.string(), perPage: v.optional(v.number()) },
  handler: async (ctx, { term, perPage }) => {
    const r = await search.search(ctx, { collection: COLLECTION, q: term, perPage: perPage ?? 25 });
    return { found: r.found, found_approximate: r.found_approximate, out_of: r.out_of, page: r.page, hitCount: r.hits.length };
  },
});

export const collectionStats = internalQuery({
  args: {},
  handler: async (ctx) => search.stats(ctx, COLLECTION),
});
