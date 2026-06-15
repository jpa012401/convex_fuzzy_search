import { describe, it, expect } from "vitest";
import { FuzzySearch } from "./index";

describe("FuzzySearch config", () => {
  it("configEntries normalizes configured collections (defaults storedFields to derived)", () => {
    const search = new FuzzySearch({} as any, {
      collections: {
        products: { searchFields: ["name"], filterFields: [{ field: "brand", type: "string" }] },
        articles: { searchFields: ["title"], storedFields: "all" },
      },
    });
    const entries = search.configEntries();
    expect(entries).toContainEqual(expect.objectContaining({ name: "products", storedFields: "derived" }));
    expect(entries).toContainEqual(expect.objectContaining({ name: "articles", storedFields: "all" }));
    const products = entries.find((e) => e.name === "products");
    expect(products?.filterFields).toEqual([{ field: "brand", type: "string" }]);
  });

  it("configEntries is empty when no collections configured", () => {
    const search = new FuzzySearch({} as any);
    expect(search.configEntries()).toEqual([]);
  });
});
