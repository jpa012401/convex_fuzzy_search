import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function seeded() {
  const c = convexTest(schema, modules);
  registerAggregate(c, "docCount");
  registerAggregate(c, "sortIndex");
  await c.mutation(api.collections.createCollection, {
    name: "jobs",
    searchFields: ["title"],
    storedFields: "all",
    facetFields: ["category"],
    sortSpecs: [[{ field: "postedAt", order: "desc" as const }]],
    rankProfiles: {
      feed: {
        base: "postedAt:desc",
        window: 10,
        terms: [
          { id: "partner", type: "flag", weight: 100, field: "partnered" },
          { id: "fresh", type: "recencyDecay", weight: 1, field: "postedAt", halfLifeMs: 8.64e7 },
          { id: "pref", type: "setBoost", weight: 50, field: "category", setKey: "prefCats" },
          { id: "rel", type: "relevance", weight: 1 },
        ],
      },
    },
  });
  const now = 1_000_000_000_000;
  const docs = [
    { id: "old-partner", doc: { id: "old-partner", title: "engineer", partnered: true,  postedAt: now - 5 * 8.64e7, category: "Eng" } },
    { id: "new-plain",   doc: { id: "new-plain",   title: "engineer", partnered: false, postedAt: now - 1 * 8.64e7, category: "Sales" } },
    { id: "old-plain",   doc: { id: "old-plain",   title: "engineer", partnered: false, postedAt: now - 9 * 8.64e7, category: "Eng" } },
  ];
  for (const d of docs) await c.mutation(api.write.upsert, { collection: "jobs", ...d });
  return { c, now };
}
const ids = (r: any) => r.hits.map((h: any) => h.document.id);

describe("rank profiles re-rank a browse window", () => {
  it("partnered flag (huge weight) floats an old job to the top despite base=newest", async () => {
    const { c, now } = await seeded();
    const r = await c.query(api.search.search, {
      collection: "jobs", q: "",
      rank: { profile: "feed", context: { now } },
    });
    expect(ids(r)[0]).toBe("old-partner");
    expect(r.found).toBe(3);
    expect(r.out_of).toBe(3);
    expect(r.reranked).toBe(true);
  });

  it("setBoost via context floats preferred-category jobs", async () => {
    const { c, now } = await seeded();
    const r = await c.query(api.search.search, {
      collection: "jobs", q: "",
      rank: { profile: "feed", weights: { partner: 0 }, context: { now, sets: { prefCats: ["Eng"] } } },
    });
    expect(ids(r).slice(0, 2).sort()).toEqual(["old-partner", "old-plain"]);
    expect(ids(r)[2]).toBe("new-plain");
  });

  it("text query: relevance term blends; found is the matched count", async () => {
    const { c, now } = await seeded();
    const r = await c.query(api.search.search, {
      collection: "jobs", q: "engineer",
      rank: { profile: "feed", weights: { rel: 0, fresh: 0, pref: 0 }, context: { now } },
    });
    expect(r.found).toBe(3);
    expect(ids(r)[0]).toBe("old-partner");
    expect(r.reranked).toBe(true);
  });

  it("unknown profile throws", async () => {
    const { c } = await seeded();
    await expect(
      c.query(api.search.search, { collection: "jobs", q: "", rank: { profile: "nope" } }),
    ).rejects.toThrow(/rank profile/i);
  });

  it("non-rank queries report reranked: true", async () => {
    const { c } = await seeded();
    const r = await c.query(api.search.search, { collection: "jobs", q: "" });
    expect(r.reranked).toBe(true);
  });
});
