import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import { register as registerFuzzySearch } from "@elevatech/fuzzy-search/test";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob("./**/*.ts");

async function seeded(t: any, n = 30) {
  // The example app embeds the fuzzySearch component, which itself embeds two
  // aggregate sub-components. Register all three at their nested paths.
  registerFuzzySearch(t);
  registerAggregate(t, "fuzzySearch/docCount");
  registerAggregate(t, "fuzzySearch/sortIndex");
  const r = await t.mutation(api.places.seedPlaces, { total: n });
  return r.now as number; // anchor for context.now
}

describe("places backend", () => {
  it("seeds and searches by cuisine text + hydrates", async () => {
    const t = convexTest(schema, modules);
    await seeded(t);
    const r = await t.query(api.places.searchPlaces, { q: "", perPage: 5 });
    expect(r.found).toBeGreaterThan(0);
    expect(r.hits[0].document.name).toBeDefined();
  });

  it("geoDistance ranks nearer places first", async () => {
    const t = convexTest(schema, modules);
    const now = await seeded(t, 40);
    const r = await t.query(api.places.searchPlaces, {
      q: "", perPage: 5,
      rank: { profile: "nearby", context: { now, origin: { lat: 37.7749, lng: -122.4194 } } },
    });
    expect(r.hits.length).toBeGreaterThan(0);
    const dist = (h: any) => {
      const d = h.document; if (d.lat == null) return Infinity;
      return Math.hypot(d.lat - 37.7749, d.lng + 122.4194);
    };
    expect(dist(r.hits[0])).toBeLessThanOrEqual(dist(r.hits[r.hits.length - 1]) + 0.5);
  });

  it("cuisine facet returns counts", async () => {
    const t = convexTest(schema, modules);
    await seeded(t, 40);
    const r = await t.query(api.places.searchPlaces, { q: "", facetBy: ["cuisine"], perPage: 2 });
    const f = r.facet_counts.find((f: any) => f.field_name === "cuisine");
    expect(f).toBeDefined();
    expect(f!.counts.length).toBeGreaterThan(0);
  });
});
