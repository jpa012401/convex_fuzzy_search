import { describe, it, expect } from "vitest";
import { tokenize } from "../src/component/tokenizer";

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
