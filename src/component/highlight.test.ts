import { describe, it, expect } from "vitest";
import { highlightField } from "./highlight";

const terms = (...t: string[]) => new Set(t);

describe("highlightField", () => {
  it("wraps a matched word preserving original case and punctuation", () => {
    expect(highlightField("Red Running Shoe!", terms("running"))).toEqual({
      snippet: "Red <mark>Running</mark> Shoe!",
      matched_tokens: ["Running"],
    });
  });

  it("wraps multiple distinct matches and dedups matched_tokens", () => {
    expect(highlightField("run run RUN", terms("run"))).toEqual({
      snippet: "<mark>run</mark> <mark>run</mark> <mark>RUN</mark>",
      matched_tokens: ["run", "RUN"],
    });
  });

  it("returns null when nothing matches", () => {
    expect(highlightField("blue hat", terms("running"))).toBeNull();
  });

  it("escapes HTML in the field text but keeps mark tags", () => {
    expect(highlightField("a <b> run", terms("run"))).toEqual({
      snippet: "a &lt;b&gt; <mark>run</mark>",
      matched_tokens: ["run"],
    });
  });

  it("returns null for non-string or empty input", () => {
    expect(highlightField("", terms("x"))).toBeNull();
    expect(highlightField(undefined as unknown as string, terms("x"))).toBeNull();
  });
});
