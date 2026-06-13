import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

describe("collections", () => {
  it("creates and reads a collection", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name", "description"],
    });
    const c = await t.query(api.collections.getCollection, { name: "products" });
    expect(c).toMatchObject({
      name: "products",
      searchFields: ["name", "description"],
      storedFields: "all",
    });
  });

  it("rejects duplicate collection names", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name"],
    });
    await expect(
      t.mutation(api.collections.createCollection, {
        name: "products",
        searchFields: ["name"],
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("getCollection returns null for unknown name", async () => {
    const t = convexTest(schema, modules);
    expect(
      await t.query(api.collections.getCollection, { name: "nope" }),
    ).toBeNull();
  });
});
