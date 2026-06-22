import { describe, it, expect } from "vitest";
import {
  reverifyAnd,
  synthScore,
  pickSearchSlot,
  clampK,
  orderCandidates,
  tallyFacets,
  resolveFoundAndFacets,
  type Candidate,
} from "./searchRead";
import type { SlotMap } from "./slotMap";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob("./**/*.ts");

function cand(docId: string, slotText: string, rankPos: number): Candidate {
  return { docId, stored: {}, slotText, rankPos };
}

describe("synthScore", () => {
  it("maps rank 0 of N to 1.0 and last to ~1/N", () => {
    expect(synthScore(0, 4)).toBe(1);
    expect(synthScore(3, 4)).toBe(0.25);
    expect(synthScore(1, 4)).toBe(0.75);
  });
  it("returns 0 when total <= 0", () => {
    expect(synthScore(0, 0)).toBe(0);
    expect(synthScore(5, -1)).toBe(0);
  });
});

describe("reverifyAnd", () => {
  it("keeps only candidates whose slotText contains ALL query tokens", () => {
    const cands = [
      cand("a", "red running shoes", 0),
      cand("b", "red shoes", 1),
      cand("c", "blue running shoes", 2),
    ];
    const kept = reverifyAnd(cands, ["red", "running"]);
    expect(kept.map((c) => c.docId)).toEqual(["a"]);
  });
  it("re-tokenizes slotText (case-insensitive, punctuation split) before matching", () => {
    const cands = [cand("a", "Red, RUNNING-Shoes!", 0)];
    const kept = reverifyAnd(cands, ["red", "running", "shoes"]);
    expect(kept.map((c) => c.docId)).toEqual(["a"]);
  });
  it("returns all candidates unchanged when queryTokens is empty", () => {
    const cands = [cand("a", "anything", 0), cand("b", "", 1)];
    expect(reverifyAnd(cands, [])).toEqual(cands);
  });
  it("preserves input order of surviving candidates", () => {
    const cands = [
      cand("a", "alpha beta", 0),
      cand("b", "beta", 1),
      cand("c", "alpha beta gamma", 2),
    ];
    const kept = reverifyAnd(cands, ["alpha", "beta"]);
    expect(kept.map((c) => c.docId)).toEqual(["a", "c"]);
  });
  it("treats the LAST token as a prefix (search-as-you-type)", () => {
    // "jacke" is not a full token in "rain jacket" but IS a prefix of "jacket".
    // Native .searchIndex prefix-matches the last token; reverifyAnd must not
    // reject it (the bug: requiring exact presence dropped all prefix hits).
    const cands = [
      cand("a", "rain jacket", 0),
      cand("b", "rain boots", 1),
    ];
    const kept = reverifyAnd(cands, ["rain", "jacke"]);
    expect(kept.map((c) => c.docId)).toEqual(["a"]); // b lacks a "jacke*" token
  });
  it("non-last tokens still require EXACT presence (only the last is a prefix)", () => {
    // "jac" as a non-last token must NOT prefix-match "jacket".
    const cands = [cand("a", "jacket shoe", 0)];
    expect(reverifyAnd(cands, ["jac", "shoe"]).map((c) => c.docId)).toEqual([]);
    // but as the last token it prefix-matches:
    expect(reverifyAnd(cands, ["shoe", "jac"]).map((c) => c.docId)).toEqual(["a"]);
  });
});

describe("pickSearchSlot", () => {
  const slotMap: SlotMap = {
    search: { title: "text1", body: "text2" },
    strFilter: {},
    numFilter: {},
  };
  it("single queryBy field -> its mapped textN slot + matching sN index", () => {
    expect(pickSearchSlot(["title"], slotMap)).toEqual({ indexName: "s1", slot: "text1" });
    expect(pickSearchSlot(["body"], slotMap)).toEqual({ indexName: "s2", slot: "text2" });
  });
  it("no queryBy -> s0/text0 (all-text concatenation)", () => {
    expect(pickSearchSlot(undefined, slotMap)).toEqual({ indexName: "s0", slot: "text0" });
    expect(pickSearchSlot([], slotMap)).toEqual({ indexName: "s0", slot: "text0" });
  });
  it("multiple queryBy fields -> s0/text0 (all-text)", () => {
    expect(pickSearchSlot(["title", "body"], slotMap)).toEqual({ indexName: "s0", slot: "text0" });
  });
  it("throws when the single queryBy field is not a mapped search field", () => {
    expect(() => pickSearchSlot(["nope"], slotMap)).toThrow(/not a searchable field/i);
  });
});

describe("clampK", () => {
  it("clamps the re-rank window into [1, 1024]", () => {
    expect(clampK(0)).toBe(1);
    expect(clampK(200)).toBe(200);
    expect(clampK(5000)).toBe(1024);
  });
});

describe("1-based paging (F4)", () => {
  const pageStart = (page: number, perPage: number) => (Math.max(1, Math.floor(page)) - 1) * perPage;
  it("page 1 starts at 0; page 2 starts at perPage", () => {
    expect(pageStart(1, 10)).toBe(0);
    expect(pageStart(2, 10)).toBe(10);
    expect(pageStart(0, 10)).toBe(0); // clamps to page 1
  });
});

describe("runEmptyQFilterQuery (F8 by_collection_doc + in-memory eq/postFilter)", () => {
  it("returns only rows matching the native eq AND the in-memory postFilter, bounded by take", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");
    await t.mutation(api.collections.createCollection, {
      name: "shop",
      searchFields: ["name"],
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
      ],
    });
    await t.mutation(api.write.upsertMany, {
      collection: "shop",
      docs: [
        { id: "a", doc: { name: "x", brand: "acme", price: 10 } },
        { id: "b", doc: { name: "y", brand: "acme", price: 99 } },
        { id: "c", doc: { name: "z", brand: "other", price: 10 } },
      ],
    });
    // brand:acme (native eq) AND price < 50 (in-memory postFilter) -> only "a".
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      filterBy: 'brand:acme && price:<50',
    });
    expect(r.hits.map((h: any) => h.id).sort()).toEqual(["a"]);
    expect(r.found).toBe(1);
  });
});

// ---- Task 9: orderCandidates, tallyFacets, resolveFoundAndFacets ----

const c = (docId: string, rankPos: number, stored: Record<string, unknown> = {}): Candidate => ({
  docId, rankPos, stored, slotText: "",
});

describe("orderCandidates", () => {
  it("no rank/rankBy/sortBy -> relevance via synthScore (native rank asc)", () => {
    const cands = [c("a", 2), c("b", 0), c("c", 1)];
    const out = orderCandidates(cands, {});
    expect(out.map((x) => x.docId)).toEqual(["b", "c", "a"]);
  });

  it("rank profile uses evalTerms(stored, terms, weights, synthScore(rankPos,total), context)", () => {
    const cands = [
      c("a", 0, { boost: 1 }),
      c("b", 1, { boost: 100 }),
    ];
    const out = orderCandidates(cands, {
      rank: {
        profile: { base: "default", terms: [{ id: "f", type: "field", weight: 1, field: "boost" }] },
      },
    });
    // b's field contribution (100) dominates a's (1) despite worse rank.
    expect(out.map((x) => x.docId)).toEqual(["b", "a"]);
  });

  it("sortBy on a stored numeric field overrides relevance", () => {
    const cands = [c("a", 0, { price: 30 }), c("b", 1, { price: 10 })];
    const out = orderCandidates(cands, { sortBy: [{ field: "price", order: "asc" }] });
    expect(out.map((x) => x.docId)).toEqual(["b", "a"]);
  });
});

describe("tallyFacets (query-scoped, F5)", () => {
  it("counts stored field values over the candidate window, count desc then value asc, capped at maxValues", () => {
    const cands = [
      c("a", 0, { brand: "acme" }),
      c("b", 1, { brand: "acme" }),
      c("c", 2, { brand: "zeta" }),
      c("d", 3, { brand: "mid" }),
      c("e", 4, {}), // missing -> skipped
    ];
    const fc = tallyFacets(cands, ["brand"], 2);
    expect(fc).toEqual([
      { field_name: "brand", counts: [
        { value: "acme", count: 2 },
        { value: "mid", count: 1 },
      ] },
    ]);
  });
});

describe("resolveFoundAndFacets routing (F5/F6)", () => {
  it("queryPresent -> tallyFacets over candidates with facets_scoped=true; found=candidate count", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");
    await t.mutation(api.collections.createCollection, {
      name: "qf",
      searchFields: ["name"],
      facetFields: ["brand"],
    });
    const { resolveFoundAndFacets: rff } = await import("./searchRead");
    await t.run(async (ctx: any) => {
      const cands: Candidate[] = [
        { docId: "a", rankPos: 0, slotText: "", stored: { brand: "acme" } },
        { docId: "b", rankPos: 1, slotText: "", stored: { brand: "acme" } },
      ];
      const r = await rff(ctx, "qf", cands, {
        queryPresent: true,
        facetFields: ["brand"],
        declaredFacets: new Set(["brand"]),
        maxFacetValues: 10,
        foundApproximate: false,
      });
      expect(r.found).toBe(2);
      expect(r.facets_scoped).toBe(true);
      expect(r.facet_counts).toEqual([
        { field_name: "brand", counts: [{ value: "acme", count: 2 }] },
      ]);
    });
  });

  it("empty-q browse -> readFacetCounts over the facetCounts TABLE; facets_scoped=false", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");
    await t.mutation(api.collections.createCollection, {
      name: "bf",
      searchFields: ["name"],
      facetFields: ["brand"],
    });
    await t.mutation(api.write.upsertMany, {
      collection: "bf",
      docs: [
        { id: "a", doc: { name: "x", brand: "acme" } },
        { id: "b", doc: { name: "y", brand: "acme" } },
        { id: "c", doc: { name: "z", brand: "zeta" } },
      ],
    });
    const { resolveFoundAndFacets: rff } = await import("./searchRead");
    await t.run(async (ctx: any) => {
      const r = await rff(ctx, "bf", [], {
        queryPresent: false,
        facetFields: ["brand"],
        declaredFacets: new Set(["brand"]),
        maxFacetValues: 10,
        foundApproximate: false,
        browseOutOf: 3,
      });
      expect(r.facets_scoped).toBe(false);
      expect(r.facet_counts[0].counts).toEqual([
        { value: "acme", count: 2 },
        { value: "zeta", count: 1 },
      ]);
      expect(r.found).toBe(3);
    });
  });

  it("docCount aggregate correctly tracked: out_of and found reflect upserted doc count", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");
    await t.mutation(api.collections.createCollection, {
      name: "counttest",
      searchFields: ["name"],
    });
    await t.mutation(api.write.upsertMany, {
      collection: "counttest",
      docs: [
        { id: "d1", doc: { name: "alpha" } },
        { id: "d2", doc: { name: "beta" } },
        { id: "d3", doc: { name: "gamma" } },
      ],
    });
    // Verify out_of reflects the collectionCount aggregate (docCount gap closure)
    const r = await t.query(api.search.search, {
      collection: "counttest",
      q: "",
    });
    expect(r.out_of).toBe(3);
    expect(r.found).toBe(3);
  });
});
