import { describe, it, expect } from "vitest";
import { orderingScore, compareMatches } from "./ranking";
import type { RankBy, SortKey } from "./ranking";

describe("orderingScore", () => {
  it("returns text_match when no rankBy", () => {
    expect(orderingScore(3, { price: 10 }, undefined)).toBe(3);
  });
  it("blends text weight + field weights", () => {
    const rankBy: RankBy = { text: 1, fields: [{ field: "popularity", weight: 0.5 }] };
    expect(orderingScore(2, { popularity: 10 }, rankBy)).toBe(2 + 5);
  });
  it("text defaults to 1; non-numeric field coerces to 0", () => {
    const rankBy: RankBy = { fields: [{ field: "pop", weight: 2 }] };
    expect(orderingScore(3, {}, rankBy)).toBe(3);
    expect(orderingScore(3, { pop: "x" }, rankBy)).toBe(3);
  });
});

describe("compareMatches", () => {
  const stored: Record<string, Record<string, unknown>> = {
    a: { price: 30 },
    b: { price: 10 },
    c: { price: 10 },
  };
  const score: Record<string, number> = { a: 1, b: 2, c: 2 };
  const cmp = (sortBy?: SortKey[]) => (x: string, y: string) =>
    compareMatches(x, y, {
      score: (id) => score[id],
      stored: (id) => stored[id],
      sortBy,
    });

  it("defaults to score desc, docId asc tie-break", () => {
    expect(["a", "b", "c"].sort(cmp())).toEqual(["b", "c", "a"]);
  });
  it("sorts by a numeric field ascending", () => {
    expect(["a", "b", "c"].sort(cmp([{ field: "price", order: "asc" }]))).toEqual(["b", "c", "a"]);
  });
  it("multi-key: price asc then docId tie-break", () => {
    expect(["c", "b", "a"].sort(cmp([{ field: "price", order: "asc" }]))).toEqual(["b", "c", "a"]);
  });
  it("_text_match key uses the score", () => {
    expect(["a", "b", "c"].sort(cmp([{ field: "_text_match", order: "desc" }]))).toEqual(["b", "c", "a"]);
  });
});
