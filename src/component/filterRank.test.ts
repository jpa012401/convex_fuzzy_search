import { describe, it, expect } from "vitest";
import {
  resolveEqFilters,
  resolveRankProfile,
} from "./filterRank";
import type { SlotMap } from "./slotMap";
import type { FieldType } from "./filter";
import type { RankProfile } from "./schema";

const slotMap: SlotMap = {
  search: { title: "text1" },
  strFilter: { brand: "filt0", category: "filt1" },
  numFilter: { price: "numF0", year: "numF1" },
};
const fieldTypes: Record<string, FieldType> = {
  brand: "string",
  category: "string",
  price: "number",
  year: "number",
};

describe("resolveEqFilters", () => {
  it("string equality on a mapped field -> native .eq on its filt slot, no postFilter", () => {
    const r = resolveEqFilters('brand:Nike', slotMap, fieldTypes);
    expect(r.eq).toEqual([{ slot: "filt0", value: "Nike" }]);
    expect(r.postFilter).toBeNull();
  });

  it("numeric equality on a mapped field -> native .eq on its numF slot", () => {
    const r = resolveEqFilters('year:2024', slotMap, fieldTypes);
    expect(r.eq).toEqual([{ slot: "numF1", value: 2024 }]);
    expect(r.postFilter).toBeNull();
  });

  it("ANDed equalities -> multiple native .eq clauses, no postFilter", () => {
    const r = resolveEqFilters('brand:Nike && category:shoes', slotMap, fieldTypes);
    expect(r.eq).toEqual([
      { slot: "filt0", value: "Nike" },
      { slot: "filt1", value: "shoes" },
    ]);
    expect(r.postFilter).toBeNull();
  });

  it("a numeric range -> a postFilter Predicate (no native eq for it)", () => {
    const r = resolveEqFilters('price:[10..20]', slotMap, fieldTypes);
    expect(r.eq).toEqual([]);
    expect(r.postFilter).not.toBeNull();
    const p = r.postFilter!;
    expect(p({ price: 15 })).toBe(true);
    expect(p({ price: 5 })).toBe(false);
    expect(p({ price: 25 })).toBe(false);
  });

  it("comparator -> postFilter Predicate", () => {
    const r = resolveEqFilters('price:>100', slotMap, fieldTypes);
    expect(r.eq).toEqual([]);
    const p = r.postFilter!;
    expect(p({ price: 150 })).toBe(true);
    expect(p({ price: 50 })).toBe(false);
  });

  it("equality AND range -> eq for the equality, postFilter for the range", () => {
    const r = resolveEqFilters('brand:Nike && price:[10..20]', slotMap, fieldTypes);
    expect(r.eq).toEqual([{ slot: "filt0", value: "Nike" }]);
    expect(r.postFilter).not.toBeNull();
    const p = r.postFilter!;
    expect(p({ price: 15 })).toBe(true);
    expect(p({ price: 99 })).toBe(false);
  });

  it("OR anywhere -> whole thing becomes a postFilter (cannot push to native eq)", () => {
    const r = resolveEqFilters('brand:Nike || brand:Adidas', slotMap, fieldTypes);
    expect(r.eq).toEqual([]);
    expect(r.postFilter).not.toBeNull();
    const p = r.postFilter!;
    expect(p({ brand: "Nike" })).toBe(true);
    expect(p({ brand: "Adidas" })).toBe(true);
    expect(p({ brand: "Puma" })).toBe(false);
  });

  it("inSet -> postFilter (native eq is single-value)", () => {
    const r = resolveEqFilters('brand:[Nike,Adidas]', slotMap, fieldTypes);
    expect(r.eq).toEqual([]);
    const p = r.postFilter!;
    expect(p({ brand: "Adidas" })).toBe(true);
    expect(p({ brand: "Puma" })).toBe(false);
  });

  it("empty/whitespace filterBy -> no eq, no postFilter", () => {
    expect(resolveEqFilters("", slotMap, fieldTypes)).toEqual({ eq: [], postFilter: null });
    expect(resolveEqFilters("   ", slotMap, fieldTypes)).toEqual({ eq: [], postFilter: null });
  });

  it("equality on a field with no slot -> postFilter (cannot push to native)", () => {
    const sm: SlotMap = { search: {}, strFilter: {}, numFilter: {} };
    const r = resolveEqFilters('brand:Nike', sm, fieldTypes);
    expect(r.eq).toEqual([]);
    expect(r.postFilter).not.toBeNull();
    expect(r.postFilter!({ brand: "Nike" })).toBe(true);
  });
});

const profile: RankProfile = {
  base: "relevance",
  terms: [
    { id: "rel", type: "relevance", weight: 1 },
    { id: "pop", type: "field", weight: 2, field: "popularity" },
  ],
};

describe("resolveRankProfile", () => {
  it("returns undefined when rank arg is absent", () => {
    expect(resolveRankProfile({ rankProfiles: { default: profile } }, undefined)).toBeUndefined();
  });

  it("resolves a known profile and passes weights/context through", () => {
    const r = resolveRankProfile(
      { rankProfiles: { default: profile } },
      { profile: "default", weights: { pop: 5 }, context: { now: 123 } },
    );
    expect(r).toEqual({ profile, weights: { pop: 5 }, context: { now: 123 } });
  });

  it("throws on an unknown rank profile naming it", () => {
    expect(() =>
      resolveRankProfile({ rankProfiles: { default: profile } }, { profile: "nope" }),
    ).toThrow(/Unknown rank profile "nope"/);
  });

  it("throws on a weight-id override that is not a term id, naming both", () => {
    expect(() =>
      resolveRankProfile(
        { rankProfiles: { default: profile } },
        { profile: "default", weights: { bogus: 3 } },
      ),
    ).toThrow(/Unknown rank weight override "bogus" for profile "default"/);
  });

  it("throws unknown profile when the collection has no rankProfiles at all", () => {
    expect(() => resolveRankProfile({}, { profile: "default" })).toThrow(
      /Unknown rank profile "default"/,
    );
  });
});
