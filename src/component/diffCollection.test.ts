import { describe, it, expect } from "vitest";
import { diffCollection } from "./diffCollection";

const base = {
  searchFields: ["title"],
  storedFields: "derived" as const,
  filterFields: [{ field: "brand", type: "string" as const }],
  facetFields: ["brand"],
  sortSpecs: [[{ field: "price", order: "asc" as const }]],
  rankProfiles: {},
};

describe("diffCollection", () => {
  it("create when stored is null", () => {
    expect(diffCollection(null, base).kind).toBe("create");
  });
  it("metadata-only when rankProfiles change", () => {
    const d = diffCollection(base, { ...base, rankProfiles: { x: { base: "price:asc", terms: [] } } });
    expect(d.kind).toBe("update");
    expect(d.pendingFields).toEqual([]);
  });
  it("structural add flags the new filter field as pending", () => {
    const d = diffCollection(base, {
      ...base,
      filterFields: [...base.filterFields, { field: "color", type: "string" as const }],
    });
    expect(d.kind).toBe("update");
    expect(d.pendingFields).toContain("color");
  });
  it("structural add flags a new facet field", () => {
    const d = diffCollection(base, { ...base, facetFields: ["brand", "size"] });
    expect(d.pendingFields).toContain("size");
  });
  it("structural add flags a new sortSpec field", () => {
    const d = diffCollection(base, {
      ...base,
      sortSpecs: [...base.sortSpecs, [{ field: "rating", order: "desc" as const }]],
    });
    expect(d.pendingFields).toContain("rating");
  });
  it("removal is not pending (lazy)", () => {
    const d = diffCollection(base, { ...base, filterFields: [] });
    expect(d.pendingFields).toEqual([]);
  });

  it("create lists all structural fields as pending", () => {
    const d = diffCollection(null, base);
    expect(d.kind).toBe("create");
    expect(d.pendingFields.sort()).toEqual(["brand", "price"].sort());
  });

  it("a field newly added to two roles appears once in pendingFields", () => {
    const start = { ...base, filterFields: [], facetFields: [] as string[] };
    const d = diffCollection(start, {
      ...start,
      filterFields: [{ field: "size", type: "string" as const }],
      facetFields: ["size"],
    });
    expect(d.pendingFields.filter((f) => f === "size")).toEqual(["size"]); // exactly once
  });
});
