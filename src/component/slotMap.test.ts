import { describe, it, expect } from "vitest";
import { assignSlots, SLOT_LIMITS } from "./slotMap";

describe("assignSlots", () => {
  it("maps search fields to text1.. in first-declared order (text0 reserved for concat)", () => {
    const m = assignSlots({ searchFields: ["title", "body", "brand"] });
    expect(m.search).toEqual({ title: "text1", body: "text2", brand: "text3" });
  });

  it("maps string and number filter fields to filtN / numFN independently", () => {
    const m = assignSlots({
      searchFields: ["title"],
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
        { field: "category", type: "string" },
        { field: "rating", type: "number" },
      ],
    });
    expect(m.search).toEqual({ title: "text1" });
    expect(m.strFilter).toEqual({ brand: "filt0", category: "filt1" });
    expect(m.numFilter).toEqual({ price: "numF0", rating: "numF1" });
  });

  it("is idempotent and stable: identical config yields identical mapping", () => {
    const cfg = {
      searchFields: ["title", "body"],
      filterFields: [
        { field: "brand", type: "string" as const },
        { field: "price", type: "number" as const },
      ],
    };
    expect(assignSlots(cfg)).toEqual(assignSlots(cfg));
  });

  it("keeps earlier fields on their slots when a new field is appended (stable re-sync)", () => {
    const before = assignSlots({ searchFields: ["title", "body"] });
    const after = assignSlots({ searchFields: ["title", "body", "tags"] });
    expect(after.search.title).toBe(before.search.title);
    expect(after.search.body).toBe(before.search.body);
    expect(after.search.tags).toBe("text3");
  });

  it("dedups a field declared twice to a single slot", () => {
    const m = assignSlots({ searchFields: ["title", "title", "body"] });
    expect(m.search).toEqual({ title: "text1", body: "text2" });
  });

  it("fills exactly to the search field cap (8 named -> text1..text8)", () => {
    const fields = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const m = assignSlots({ searchFields: fields });
    expect(Object.keys(m.search)).toHaveLength(SLOT_LIMITS.search);
    expect(m.search.a).toBe("text1");
    expect(m.search.h).toBe("text8");
  });

  it("throws naming the search cap when too many search fields are declared", () => {
    const fields = ["a", "b", "c", "d", "e", "f", "g", "h", "i"]; // 9 > 8
    expect(() => assignSlots({ searchFields: fields })).toThrow(/search field.*cap.*8/i);
  });

  it("throws naming the string-filter cap when too many string filters are declared", () => {
    const filterFields = Array.from({ length: 9 }, (_, i) => ({
      field: `f${i}`,
      type: "string" as const,
    }));
    expect(() => assignSlots({ searchFields: ["title"], filterFields })).toThrow(
      /string filter.*cap.*8/i,
    );
  });

  it("throws naming the numeric-filter cap when too many numeric filters are declared", () => {
    const filterFields = Array.from({ length: 5 }, (_, i) => ({
      field: `n${i}`,
      type: "number" as const,
    }));
    expect(() => assignSlots({ searchFields: ["title"], filterFields })).toThrow(
      /numeric filter.*cap.*4/i,
    );
  });

  it("exposes the FINAL caps", () => {
    expect(SLOT_LIMITS).toEqual({ search: 8, strFilter: 8, numFilter: 4 });
  });
});
