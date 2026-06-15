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

  it("pendingFields reads the collection's pending list via getCollection", async () => {
    const runQuery = vi.fn().mockResolvedValue({ name: "p", pendingFields: ["brand"] });
    const search = new FuzzySearch({ collections: { getCollection: "ref" } } as any);
    const pending = await search.pendingFields({ runQuery } as any, "p");
    expect(pending).toEqual(["brand"]);
    expect(runQuery).toHaveBeenCalledWith("ref", { name: "p" });
  });

  it("pendingFields returns [] when the row has no pending list or is null", async () => {
    const search = new FuzzySearch({ collections: { getCollection: "ref" } } as any);
    expect(await search.pendingFields({ runQuery: vi.fn().mockResolvedValue(null) } as any, "p")).toEqual([]);
    expect(await search.pendingFields({ runQuery: vi.fn().mockResolvedValue({ name: "p" }) } as any, "p")).toEqual([]);
  });

  it("clearPending calls the clearPendingFields mutation", async () => {
    const runMutation = vi.fn().mockResolvedValue(undefined);
    const search = new FuzzySearch({ configSync: { clearPendingFields: "ref" } } as any);
    await search.clearPending({ runMutation } as any, "p");
    expect(runMutation).toHaveBeenCalledWith("ref", { collection: "p" });
  });
});
