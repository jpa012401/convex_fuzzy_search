import { describe, it, expect } from "vitest";
import { indexRelevantFields } from "./storedFields";

describe("indexRelevantFields", () => {
  it("unions all role fields", () => {
    const fields = indexRelevantFields({
      searchFields: ["title", "body"],
      filterFields: [{ field: "brand", type: "string" }],
      facetFields: ["brand", "category"],
      sortSpecs: [[{ field: "price", order: "asc" }]],
      rankProfiles: {
        boosted: {
          base: "price:asc",
          terms: [
            { id: "r", type: "recencyDecay", weight: 1, field: "createdAt", halfLifeMs: 1 },
            { id: "g", type: "geoDistance", weight: 1, latField: "lat", lngField: "lng", maxKm: 5 },
            { id: "rel", type: "relevance", weight: 1 },
          ],
        },
      },
    });
    expect(fields.sort()).toEqual(
      ["body", "brand", "category", "createdAt", "lat", "lng", "price", "title"].sort(),
    );
  });

  it("handles empty/optional roles", () => {
    expect(indexRelevantFields({ searchFields: ["t"] })).toEqual(["t"]);
  });

  it("dedups a field referenced by multiple roles", () => {
    const fields = indexRelevantFields({
      searchFields: ["name"],
      filterFields: [{ field: "name", type: "string" }],
      facetFields: ["name"],
    });
    expect(fields).toEqual(["name"]);
  });
});
