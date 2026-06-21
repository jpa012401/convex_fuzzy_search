import { describe, it, expect } from "vitest";
import {
  reverifyAnd,
  synthScore,
  pickSearchSlot,
  type Candidate,
} from "./searchRead";
import type { SlotMap } from "./slotMap";

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
