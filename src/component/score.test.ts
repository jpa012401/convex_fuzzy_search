import { describe, it, expect } from "vitest";
import { evalTerms, haversineKm, recencyDecay, type RankTerm } from "./score";

describe("score DSL", () => {
  it("field term = weight * numField", () => {
    const terms: RankTerm[] = [{ id: "p", type: "field", weight: 2, field: "popularity" }];
    expect(evalTerms({ popularity: 5 }, terms, undefined, 0, {})).toBe(10);
    expect(evalTerms({}, terms, undefined, 0, {})).toBe(0); // missing -> 0
  });

  it("flag term: truthy, and equals", () => {
    const t1: RankTerm[] = [{ id: "f", type: "flag", weight: 3, field: "partnered" }];
    expect(evalTerms({ partnered: true }, t1, undefined, 0, {})).toBe(3);
    expect(evalTerms({ partnered: "true" }, t1, undefined, 0, {})).toBe(3);
    expect(evalTerms({ partnered: false }, t1, undefined, 0, {})).toBe(0);
    const t2: RankTerm[] = [{ id: "f", type: "flag", weight: 3, field: "tier", equals: "gold" }];
    expect(evalTerms({ tier: "gold" }, t2, undefined, 0, {})).toBe(3);
    expect(evalTerms({ tier: "silver" }, t2, undefined, 0, {})).toBe(0);
  });

  it("setBoost term: membership via context.sets[setKey]", () => {
    const terms: RankTerm[] = [{ id: "s", type: "setBoost", weight: 1.5, field: "category", setKey: "prefCats" }];
    const ctx = { sets: { prefCats: ["Eng", "Design"] } };
    expect(evalTerms({ category: "Eng" }, terms, undefined, 0, ctx)).toBe(1.5);
    expect(evalTerms({ category: "Sales" }, terms, undefined, 0, ctx)).toBe(0);
    expect(evalTerms({ category: "Eng" }, terms, undefined, 0, {})).toBe(0); // no set in context -> 0
  });

  it("recencyDecay: half-life and future-clamp", () => {
    expect(recencyDecay(0, 1000)).toBe(1);
    expect(recencyDecay(1000, 1000)).toBeCloseTo(0.5, 5);
    expect(recencyDecay(2000, 1000)).toBeCloseTo(0.25, 5);
    expect(recencyDecay(-500, 1000)).toBe(1); // future -> clamp age 0
    const terms: RankTerm[] = [{ id: "r", type: "recencyDecay", weight: 4, field: "postedAt", halfLifeMs: 1000 }];
    expect(evalTerms({ postedAt: 9000 }, terms, undefined, 0, { now: 10000 })).toBeCloseTo(4 * 0.5, 5);
    expect(evalTerms({ postedAt: 9000 }, terms, undefined, 0, {})).toBe(0); // no now -> 0
  });

  it("geoDistance: haversine + maxKm clamp + missing coords", () => {
    expect(haversineKm(0, 0, 0, 0)).toBe(0);
    expect(haversineKm(40.0, -74.0, 40.0, -74.0)).toBe(0);
    const terms: RankTerm[] = [{ id: "g", type: "geoDistance", weight: 2, latField: "lat", lngField: "lng", maxKm: 100 }];
    const here = { origin: { lat: 40.0, lng: -74.0 } };
    expect(evalTerms({ lat: 40.0, lng: -74.0 }, terms, undefined, 0, here)).toBe(2); // dist 0 -> full
    expect(evalTerms({ lat: 80.0, lng: -74.0 }, terms, undefined, 0, here)).toBe(0); // far (>100km) -> 0
    expect(evalTerms({}, terms, undefined, 0, here)).toBe(0); // no coords -> 0
    expect(evalTerms({ lat: 40, lng: -74 }, terms, undefined, 0, {})).toBe(0); // no origin -> 0
  });

  it("relevance term = weight * textMatch", () => {
    const terms: RankTerm[] = [{ id: "rel", type: "relevance", weight: 2 }];
    expect(evalTerms({}, terms, undefined, 3, {})).toBe(6);
    expect(evalTerms({}, terms, undefined, 0, {})).toBe(0);
  });

  it("evalTerms sums terms and applies per-id weight overrides", () => {
    const terms: RankTerm[] = [
      { id: "p", type: "field", weight: 1, field: "popularity" },
      { id: "f", type: "flag", weight: 3, field: "partnered" },
    ];
    expect(evalTerms({ popularity: 10, partnered: true }, terms, undefined, 0, {})).toBe(13);
    expect(evalTerms({ popularity: 10, partnered: true }, terms, { f: 0 }, 0, {})).toBe(10);
  });
});
