import { describe, it, expect, vi } from "vitest";
import { FuzzySearch } from "./index";

describe("FuzzySearch config", () => {
  it("configEntries passes through storedFields (server defaults when omitted)", () => {
    const search = new FuzzySearch({} as any, {
      collections: {
        products: { searchFields: ["name"], filterFields: [{ field: "brand", type: "string" }] },
        articles: { searchFields: ["title"], storedFields: "all" },
      },
    });
    const entries = (search as any).configEntries();
    expect(entries).toContainEqual(expect.objectContaining({ name: "products", storedFields: undefined }));
    expect(entries).toContainEqual(expect.objectContaining({ name: "articles", storedFields: "all" }));
    const products = entries.find((e: any) => e.name === "products");
    expect(products?.filterFields).toEqual([{ field: "brand", type: "string" }]);
  });

  it("configEntries is empty when no collections configured", () => {
    const search = new FuzzySearch({} as any);
    expect((search as any).configEntries()).toEqual([]);
  });

  it("sync calls applyCollectionConfig per collection and maps results", async () => {
    const runMutation = vi.fn().mockResolvedValue({ kind: "create", pendingFields: [] });
    const search = new FuzzySearch(
      { configSync: { applyCollectionConfig: "ref" } } as any,
      { collections: { a: { searchFields: ["x"] }, b: { searchFields: ["y"] } } },
    );
    const results = await search.sync({ runMutation } as any);
    expect(runMutation).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { name: "a", kind: "create", pendingFields: [] },
      { name: "b", kind: "create", pendingFields: [] },
    ]);
    // confirm the config wrapper shape was passed
    expect(runMutation).toHaveBeenCalledWith("ref", expect.objectContaining({ config: expect.objectContaining({ name: "a" }) }));
  });
});
