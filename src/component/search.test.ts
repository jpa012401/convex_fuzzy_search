import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { synthScore } from "./searchRead";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "products",
    searchFields: ["name", "description"],
  });
  const items = [
    { id: "p1", doc: { name: "Red Running Shoe", description: "for runners" } },
    { id: "p2", doc: { name: "Blue Running Jacket", description: "rain proof" } },
    { id: "p3", doc: { name: "Red Hat", description: "wool" } },
  ];
  await t.mutation(api.write.upsertMany, { collection: "products", docs: items });
  return t;
}

describe("search", () => {
  it("single token returns all matches with exact found", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, { collection: "products", q: "red" });
    expect(r.found).toBe(2);
    expect(r.out_of).toBe(3);
    // p3 = "Red Hat", p1 = "Red Running Shoe"
    expect(r.hits.map((h: any) => h.id).sort()).toEqual(["p1", "p3"]);
  });

  it("multi token is AND (all tokens must match)", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, {
      collection: "products",
      q: "red running",
    });
    expect(r.found).toBe(1);
    expect(r.hits[0].id).toBe("p1"); // "Red Running Shoe"
  });

  it("text search over many matches returns one page without loading the whole matched set", async () => {
    // Regression: the text path used to loadDocs() over EVERY matched id, which
    // could exceed the per-query read limit on large matched sets. With no facet
    // and no custom order it must load only the page's docs. We assert correct
    // paging + highlighting over a match set far larger than perPage.
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "big",
      searchFields: ["name"],
    });
    // 120 docs all containing "widget"; ids zero-padded so string order is stable.
    const docs = Array.from({ length: 120 }, (_, i) => ({
      id: `d${String(i).padStart(3, "0")}`,
      doc: { name: `widget ${i}` },
    }));
    for (let i = 0; i < docs.length; i += 50) {
      await t.mutation(api.write.upsertMany, { collection: "big", docs: docs.slice(i, i + 50) });
    }
    const r = await t.query(api.search.search, {
      collection: "big",
      q: "widget",
      perPage: 10,
      page: 1,
    });
    expect(r.found).toBe(120);          // full match count, not the page size
    expect(r.hits.length).toBe(10);     // one page
    // every hit highlights the matched term (page docs were loaded)
    for (const h of r.hits) {
      expect(h.highlight.name?.snippet).toContain("<mark>widget</mark>");
    }
    // page 2 returns a disjoint set of 10
    const r2 = await t.query(api.search.search, {
      collection: "big",
      q: "widget",
      perPage: 10,
      page: 2,
    });
    expect(r2.hits.length).toBe(10);
    const overlap = new Set(r.hits.map((h: any) => h.id));
    expect(r2.hits.some((h: any) => overlap.has(h.id))).toBe(false);
  });

  it("queryBy restricts matching fields", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, {
      collection: "products",
      q: "runners",
      queryBy: ["name"],
    });
    expect(r.found).toBe(0);
  });

  it("empty q matches all (browsing) with pagination", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, {
      collection: "products",
      q: "",
      page: 1,
      perPage: 2,
    });
    expect(r.found).toBe(3);
    expect(r.hits.length).toBe(2);
  });

  it("no match returns found 0 and empty hits with full envelope", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, { collection: "products", q: "zzz" });
    expect(r).toMatchObject({ found: 0, hits: [], facet_counts: [] });
    expect("search_time_ms" in r).toBe(false);
  });

  it("returns deterministic output for identical search inputs", async () => {
    const t = await setup();
    const args = { collection: "products", q: "red", page: 1, perPage: 10 };
    const first = await t.query(api.search.search, args);
    const second = await t.query(api.search.search, args);
    expect(second).toEqual(first);
    expect("search_time_ms" in first).toBe(false);
  });

  it("returns id + score + highlight, not document", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, { name: "books", searchFields: ["title"] });
    await t.mutation(api.write.upsert, { collection: "books", id: "b1", doc: { title: "the great gatsby" } });
    const r = await t.query(api.search.search, { collection: "books", q: "gatsby" });
    expect(r.hits[0]).toMatchObject({ id: "b1" });
    expect(typeof r.hits[0].score).toBe("number");
    expect(r.hits[0].highlight).toBeDefined();
    expect((r.hits[0] as any).document).toBeUndefined();
  });

  it("clamps perPage to at most 250 and page to at least 1", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, {
      collection: "products",
      q: "",
      page: 0,
      perPage: 9999,
    });
    expect(r.page).toBe(1);
    // 3 docs total, so the page still holds all 3, but the clamp must not throw
    // and must not page beyond bounds.
    expect(r.hits.length).toBe(3);
  });
});

describe("typo-tolerant prefix search", () => {
  it.skip(
    "prefix matches the last token (search-as-you-type)",
    /* native search: convex-test does not implement .searchIndex prefix matching.
       Covered by live smoke: example/SMOKE.md Step 3 (text search confirms prefix
       via native Convex full-text search on a deployed backend). */
    async () => {
      const t = await setup();
      const r = await t.query(api.search.search, { collection: "products", q: "run" });
      expect(r.found).toBe(2); // running (p1,p2) + runners (p1)
    },
  );

  it.skip(
    "prefix only applies to the LAST token",
    /* native search: prefix semantics are native-only; convex-test returns 0 for
       both "run shoe" and "shoe run" because no prefix expansion is simulated.
       Covered by live smoke: example/SMOKE.md Step 3 (prefix + AND re-verify). */
    async () => {
      const t = await setup();
      expect((await t.query(api.search.search, { collection: "products", q: "run shoe" })).found).toBe(0);
      expect((await t.query(api.search.search, { collection: "products", q: "shoe run" })).found).toBe(1);
    },
  );

  it.skip(
    "tolerates a typo within budget",
    /* native search: typo tolerance is provided by native Convex full-text search;
       convex-test does not simulate fuzzy/edit-distance matching.
       Covered by live smoke: example/SMOKE.md Step 3 (typo tolerance on a live backend). */
    async () => {
      const t = await setup();
      expect((await t.query(api.search.search, { collection: "products", q: "runing" })).found).toBe(2);
    },
  );

  it("rejects a typo that exceeds the budget", async () => {
    const t = await setup();
    // "runnixx" is edit-distance 2+ from "running" => no match in convex-test OR native.
    expect((await t.query(api.search.search, { collection: "products", q: "runnixx" })).found).toBe(0);
  });

  it("score is synthesized from rank position (delta D2 — replaces old exact=3/prefix=2/typo=1.5 scale)", async () => {
    // Under the hybrid design, hit.score = synthScore(rankPos, total) = (total - rankPos) / total.
    // The old hand-rolled text_match scale (exact=3, prefix=2, typo=2-0.5d) is gone.
    // Verify: top hit gets the highest synthScore; scores are non-increasing down the page.
    const t = await setup();
    const r = await t.query(api.search.search, { collection: "products", q: "running" });
    const n = r.hits.length;
    expect(n).toBeGreaterThan(0);
    expect(r.hits[0].score).toBeCloseTo(synthScore(0, n), 6); // rank 0 -> highest
    for (let i = 0; i < r.hits.length - 1; i++) {
      expect(r.hits[i].score).toBeGreaterThanOrEqual(r.hits[i + 1].score); // non-increasing
    }
  });
});

describe("filtering + faceting", () => {
  async function setupFacets() {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "shop",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
      ],
      facetFields: ["brand"],
    });
    await t.mutation(api.write.upsertMany, {
      collection: "shop",
      docs: [
        { id: "1", doc: { name: "running shoe", brand: "Aurora", price: 90 } },
        { id: "2", doc: { name: "trail shoe", brand: "Aurora", price: 110 } },
        { id: "3", doc: { name: "rain jacket", brand: "Nimbus", price: 150 } },
      ],
    });
    return t;
  }

  it("filterBy narrows the result set", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "brand:Aurora" });
    expect(r.found).toBe(2);
  });

  it("numeric comparator filter", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "price:>100" });
    expect(r.found).toBe(2);
  });

  it("filter combines with a text query (intersection)", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "shoe", filterBy: "brand:Aurora" });
    expect(r.found).toBe(2);
  });

  it("facet_counts reflect the filtered+searched set, sorted by count desc", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", facetBy: ["brand"] });
    expect(r.facet_counts).toEqual([
      { field_name: "brand", counts: [ { value: "Aurora", count: 2 }, { value: "Nimbus", count: 1 } ] },
    ]);
  });

  it("maxFacetValues caps the number of values", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", facetBy: ["brand"], maxFacetValues: 1 });
    expect(r.facet_counts[0].counts).toEqual([{ value: "Aurora", count: 2 }]);
  });

  it("facet over a filtered set is query-scoped", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "price:>100", facetBy: ["brand"] });
    expect(r.facet_counts[0].counts).toEqual([
      { value: "Aurora", count: 1 },
      { value: "Nimbus", count: 1 },
    ]);
  });

  it("absent facetBy yields empty facet_counts", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "" });
    expect(r.facet_counts).toEqual([]);
  });

  it("throws on a facet field not declared", async () => {
    const t = await setupFacets();
    await expect(
      t.query(api.search.search, { collection: "shop", q: "", facetBy: ["price"] }),
    ).rejects.toThrow(/facet/i);
  });
});

describe("highlighting + weighted sort", () => {
  async function setupShop() {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "shop",
      searchFields: ["name"],
      storedFields: "all",
    });
    await t.mutation(api.write.upsertMany, {
      collection: "shop",
      docs: [
        { id: "1", doc: { id: "1", name: "Red Running Shoe", price: 90, popularity: 1 } },
        { id: "2", doc: { id: "2", name: "Blue Running Jacket", price: 50, popularity: 100 } },
        { id: "3", doc: { id: "3", name: "Red Hat", price: 20, popularity: 5 } },
      ],
    });
    return t;
  }

  it("highlights the matched term in the field, preserving case", async () => {
    const t = await setupShop();
    const r = await t.query(api.search.search, { collection: "shop", q: "running" });
    const hit = r.hits.find((h: any) => h.id === "1");
    expect(hit).toBeDefined();
    expect(hit!.highlight).toEqual({
      name: { snippet: "Red <mark>Running</mark> Shoe", matched_tokens: ["Running"] },
    });
  });

  it.skip(
    "prefix query highlights the full term",
    /* native search: convex-test does not simulate prefix expansion, so q:"run"
       returns no hits and highlight cannot be tested here.
       Covered by live smoke: example/SMOKE.md Step 3 (native prefix returns hits;
       highlight wraps the full expanded token e.g. <mark>Running</mark>). */
    async () => {
      const t = await setupShop();
      const r = await t.query(api.search.search, { collection: "shop", q: "run" });
      const hit = r.hits.find((h: any) => h.id === "1");
      expect(hit).toBeDefined();
      expect(hit!.highlight.name.snippet).toContain("<mark>Running</mark>");
    },
  );

  it("browse mode yields empty highlight", async () => {
    const t = await setupShop();
    const r = await t.query(api.search.search, { collection: "shop", q: "" });
    expect(r.hits[0].highlight).toEqual({});
  });

  it("rankBy blends popularity to reorder (delta D2 — score is synthScore, not raw text_match)", async () => {
    const t = await setupShop();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "running",
      rankBy: { text: 1, fields: [{ field: "popularity", weight: 1 }] },
    });
    expect(r.hits[0].id).toBe("2"); // popularity 100 wins — ordering is unchanged
    // Under the hybrid design hit.score = synthScore(rankPos, total) where rankPos
    // is the NATIVE order position, NOT the reranked position.
    // The old raw text_match value (3) is gone; scores are now in (0, 1].
    for (const h of r.hits) {
      expect(typeof h.score).toBe("number");
      expect(h.score).toBeGreaterThan(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
  });

  it("sortBy price ascending orders by field", async () => {
    const t = await setupShop();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      sortBy: [{ field: "price", order: "asc" }],
    });
    expect(r.hits.map((h: any) => h.id)).toEqual(["3", "2", "1"]);
  });

  it("sortBy price descending", async () => {
    const t = await setupShop();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      sortBy: [{ field: "price", order: "desc" }],
    });
    expect(r.hits.map((h: any) => h.id)).toEqual(["1", "2", "3"]);
  });

  it("rankBy composes with a _text_match sortBy key (uses the blended score)", async () => {
    const t = await setupShop();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "running",
      rankBy: { text: 1, fields: [{ field: "popularity", weight: 1 }] },
      sortBy: [{ field: "_text_match", order: "desc" }],
    });
    expect(r.hits[0].id).toBe("2"); // blended score (popularity) drives _text_match key
  });

  it("rankBy text:0 sorts purely by the weighted field", async () => {
    const t = await setupShop();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "running",
      rankBy: { text: 0, fields: [{ field: "popularity", weight: 1 }] },
    });
    // only the two "running" docs match; ordered by popularity (100 > 1)
    expect(r.hits.map((h: any) => h.id)).toEqual(["2", "1"]);
  });

  it("empty-query custom rankBy uses a bounded window and marks broad results approximate", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "many",
      searchFields: ["name"],
      storedFields: "all",
    });
    const docs = Array.from({ length: 210 }, (_, i) => ({
        id: `p${String(i).padStart(3, "0")}`,
        doc: { name: `product ${i}`, popularity: i },
      }));
    for (let i = 0; i < docs.length; i += 50) {
      await t.mutation(api.write.upsertMany, {
        collection: "many",
        docs: docs.slice(i, i + 50),
      });
    }
    const r = await t.query(api.search.search, {
      collection: "many",
      q: "",
      rankBy: { fields: [{ field: "popularity", weight: 1 }] },
      perPage: 10,
    });
    expect(r.found).toBe(210);
    expect(r.found_approximate).toBe(true);
    expect(r.hits).toHaveLength(10);
  });
});

describe("S1 lean reads", () => {
  async function setupFacets() {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "shop",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
      ],
      facetFields: ["brand"],
    });
    await t.mutation(api.write.upsertMany, {
      collection: "shop",
      docs: [
        { id: "1", doc: { name: "running shoe", brand: "Aurora", price: 90 } },
        { id: "2", doc: { name: "trail shoe", brand: "Aurora", price: 110 } },
        { id: "3", doc: { name: "rain jacket", brand: "Nimbus", price: 150 } },
      ],
    });
    return t;
  }

  it("out_of comes from the counter and matches the collection size", async () => {
    const t = await setup(); // 3 docs (p1,p2,p3)
    const r = await t.query(api.search.search, { collection: "products", q: "" });
    expect(r.out_of).toBe(3);
  });

  it("text search returns the same results as before (lean path)", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, { collection: "products", q: "red" });
    expect(r.found).toBe(2);
    expect(r.out_of).toBe(3);
    // p3 = "Red Hat", p1 = "Red Running Shoe"
    expect(r.hits.map((h: any) => h.id).sort()).toEqual(["p1", "p3"]);
  });

  it("simple browse pages off the aggregate (docId order)", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, { collection: "products", q: "", page: 1, perPage: 2 });
    expect(r.found).toBe(3);
    expect(r.hits.length).toBe(2);
    // docId order: p1 = "Red Running Shoe", p2 = "Blue Running Jacket"
    expect(r.hits.map((h: any) => h.id)).toEqual(["p1", "p2"]);
  });

  it("browse + filter still works (fallback path)", async () => {
    const t = await setupFacets(); // shop collection w/ brand filter
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "brand:Aurora" });
    expect(r.found).toBe(2);
  });
});

describe("S2 indexed filtering", () => {
  async function setupFacets() {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "shop",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
      ],
      facetFields: ["brand"],
    });
    await t.mutation(api.write.upsertMany, {
      collection: "shop",
      docs: [
        { id: "1", doc: { name: "running shoe", brand: "Aurora", price: 90 } },
        { id: "2", doc: { name: "trail shoe", brand: "Aurora", price: 110 } },
        { id: "3", doc: { name: "rain jacket", brand: "Nimbus", price: 150 } },
      ],
    });
    return t;
  }

  it("browse + filter returns the indexed set", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "brand:Aurora" });
    expect(r.found).toBe(2);
    // brand:Aurora => id 1 ("running shoe"), id 2 ("trail shoe")
    expect(r.hits.map((h: any) => h.id).sort()).toEqual(["1", "2"]);
  });

  it("numeric range filter via index", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "price:[100..200]" });
    expect(r.found).toBe(2);
  });

  it("text + filter intersect via index", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "shoe", filterBy: "brand:Aurora" });
    expect(r.found).toBe(2);
  });

  it("filter + facet still query-scoped", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "price:>100", facetBy: ["brand"] });
    expect(r.facet_counts[0].counts).toEqual([
      { value: "Aurora", count: 1 },
      { value: "Nimbus", count: 1 },
    ]);
  });

  it("filter-only numeric range returns correct found + page without loading all matches", async () => {
    // The page-only filter branch loads ONLY the page's docs (via docKey), but
    // `found` must report the FULL matched count, not the page size.
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "priced",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "price", type: "number" }],
    });
    await t.mutation(api.write.upsertMany, {
      collection: "priced",
      docs: [
        { id: "a", doc: { name: "a", price: 40 } },
        { id: "b", doc: { name: "b", price: 90 } },
        { id: "c", doc: { name: "c", price: 110 } },
        { id: "d", doc: { name: "d", price: 150 } },
        { id: "e", doc: { name: "e", price: 300 } },
      ],
    });
    const r = await t.query(api.search.search, {
      collection: "priced", q: "", filterBy: "price:[50..150]", perPage: 2, page: 1,
    });
    expect(r.found).toBe(3); // 90, 110, 150 match; page returns only 2
    expect(r.hits.length).toBe(2);
  });

  it("filter-only paging: found is the full match count over 100 matches", async () => {
    // 100 matching docs, perPage 10 -> found 100, exactly 10 hits on the page.
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "many",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "flag", type: "string" }],
    });
    const docs = Array.from({ length: 100 }, (_, i) => ({
      id: `d${String(i).padStart(3, "0")}`,
      doc: { name: `item ${i}`, flag: "yes" },
    }));
    for (let i = 0; i < docs.length; i += 50) {
      await t.mutation(api.write.upsertMany, { collection: "many", docs: docs.slice(i, i + 50) });
    }
    const r = await t.query(api.search.search, {
      collection: "many", q: "", filterBy: "flag:yes", perPage: 10, page: 1,
    });
    expect(r.found).toBe(100);
    expect(r.hits.length).toBe(10);
    // Page 2 must return the NEXT 10 (disjoint from page 1), not an empty slice.
    const r2 = await t.query(api.search.search, {
      collection: "many", q: "", filterBy: "flag:yes", perPage: 10, page: 2,
    });
    expect(r2.found).toBe(100);
    expect(r2.hits.length).toBe(10);
    const p1 = new Set(r.hits.map((h: any) => h.id));
    expect(r2.hits.some((h: any) => p1.has(h.id))).toBe(false);
  });

  it("filter-only paging is stable across a re-upsert (full-pagination union has no skip/dup)", async () => {
    // Seed 200 matching docs, perPage 20 (10 pages). After reading page 1,
    // re-upsert an early page-1 doc — its docKey moves to the tail bucket. Then
    // page through ALL remaining pages and assert the union of every page's hits
    // covers all 200 docs exactly once. Without the docKey-ascending sort in the
    // filter-only branch, the shift caused by the re-upsert makes one doc skipped
    // and another duplicated, so the union is 199, not 200.
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "stable",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "flag", type: "string" }],
    });
    const docs = Array.from({ length: 200 }, (_, i) => ({
      id: `d${String(i).padStart(3, "0")}`,
      doc: { name: `item ${i}`, flag: "yes" },
    }));
    for (let i = 0; i < docs.length; i += 50) {
      await t.mutation(api.write.upsertMany, { collection: "stable", docs: docs.slice(i, i + 50) });
    }
    const page1 = await t.query(api.search.search, {
      collection: "stable", q: "", filterBy: "flag:yes", perPage: 20, page: 1,
    });
    expect(page1.found).toBe(200);
    expect(page1.hits.length).toBe(20);
    // Re-upsert an early page-1 doc with identical data: remove+re-add moves its
    // docKey to the tail bucket, shifting fill-order.
    const target = page1.hits[2] as any;
    const targetDoc = docs.find((d) => d.id === target.id)!;
    await t.mutation(api.write.upsert, { collection: "stable", id: targetDoc.id, doc: targetDoc.doc });
    // Page through everything and union the ids.
    const seen = new Set<string>(page1.hits.map((h: any) => h.id));
    for (let pg = 2; pg <= 10; pg++) {
      const r = await t.query(api.search.search, {
        collection: "stable", q: "", filterBy: "flag:yes", perPage: 20, page: pg,
      });
      for (const h of r.hits) seen.add((h as any).id);
    }
    // Stable pagination: every doc appears exactly once across all pages.
    expect(seen.size).toBe(200);
  });

  it("filter + facet intersects via the index", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, {
      collection: "shop", q: "", filterBy: "brand:Aurora", facetBy: ["brand"], perPage: 2,
    });
    expect(r.found).toBe(2);
    expect(r.facet_counts[0].field_name).toBe("brand");
    expect(r.facet_counts[0].counts).toEqual([{ value: "Aurora", count: 2 }]);
  });
});
