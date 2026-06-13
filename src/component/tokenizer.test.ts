import { describe, it, expect } from "vitest";
import { tokenize } from "./tokenizer";

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric", () => {
    expect(tokenize("iPhone-15 Pro!")).toEqual(["iphone", "15", "pro"]);
  });

  it("handles unicode letters and digits", () => {
    expect(tokenize("Café 2024 naïve")).toEqual(["café", "2024", "naïve"]);
  });

  it("collapses repeated separators and trims", () => {
    expect(tokenize("  a,,b  c ")).toEqual(["a", "b", "c"]);
  });

  it("returns [] for empty or separator-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("  -- ,, ")).toEqual([]);
    expect(tokenize(null as unknown as string)).toEqual([]);
  });
});

import { trigrams } from "./tokenizer";

describe("trigrams", () => {
  it("produces deduped contiguous 3-grams for length >= 3", () => {
    expect(trigrams("shoe")).toEqual(["sho", "hoe"]);
    expect(trigrams("aaaa")).toEqual(["aaa"]); // deduped
  });
  it("returns the whole term as one gram for length 1-2", () => {
    expect(trigrams("a")).toEqual(["a"]);
    expect(trigrams("re")).toEqual(["re"]);
  });
  it("returns [] for empty", () => {
    expect(trigrams("")).toEqual([]);
  });
});
