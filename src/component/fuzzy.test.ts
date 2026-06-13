import { describe, it, expect } from "vitest";
import { typoBudget, levenshtein } from "./fuzzy";

describe("typoBudget", () => {
  it("scales with token length (Typesense-style)", () => {
    expect(typoBudget(1)).toBe(0);
    expect(typoBudget(3)).toBe(0);
    expect(typoBudget(4)).toBe(1);
    expect(typoBudget(7)).toBe(1);
    expect(typoBudget(8)).toBe(2);
    expect(typoBudget(20)).toBe(2);
  });
});

describe("levenshtein", () => {
  it("returns exact distance within budget", () => {
    expect(levenshtein("phone", "phon", 2)).toBe(1);
    expect(levenshtein("running", "runing", 2)).toBe(1);
    expect(levenshtein("abc", "abc", 1)).toBe(0);
  });
  it("returns a value greater than max when distance exceeds budget (early cutoff)", () => {
    expect(levenshtein("runners", "running", 1)).toBeGreaterThan(1);
    expect(levenshtein("apple", "zzzzz", 1)).toBeGreaterThan(1);
  });
});
