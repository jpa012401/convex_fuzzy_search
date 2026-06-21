import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob("./**/*.ts");

describe("slotMap persistence (applyCollectionConfig)", () => {
  it("persists a stable slotMap for <=8 search fields", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: {
        name: "p",
        searchFields: ["title", "body"],
        storedFields: "derived",
        filterFields: [
          { field: "brand", type: "string" },
          { field: "price", type: "number" },
        ],
      },
    });
    const c = await t.query(api.collections.getCollection, { name: "p" });
    expect(c?.slotMap).toEqual({
      search: { title: "text1", body: "text2" },
      strFilter: { brand: "filt0" },
      numFilter: { price: "numF0" },
    });
  });

  it("is idempotent on re-apply (same map)", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    const cfg = {
      name: "p",
      searchFields: ["title", "body"],
      storedFields: "derived" as const,
      filterFields: [{ field: "brand", type: "string" as const }],
    };
    await t.mutation(api.configSync.applyCollectionConfig, { config: cfg });
    const first = await t.query(api.collections.getCollection, { name: "p" });
    await t.mutation(api.configSync.applyCollectionConfig, { config: cfg });
    const second = await t.query(api.collections.getCollection, { name: "p" });
    expect(second?.slotMap).toEqual(first?.slotMap);
  });

  it("keeps earlier slot assignments stable when a new field is appended", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "p", searchFields: ["title"], storedFields: "derived" },
    });
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "p", searchFields: ["title", "body"], storedFields: "derived" },
    });
    const c = await t.query(api.collections.getCollection, { name: "p" });
    expect(c?.slotMap?.search).toEqual({ title: "text1", body: "text2" });
  });

  it("throws naming the text-slot cap when >8 search fields declared", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    const searchFields = ["f1","f2","f3","f4","f5","f6","f7","f8","f9"]; // 9 > 8
    await expect(
      t.mutation(api.configSync.applyCollectionConfig, {
        config: { name: "p", searchFields, storedFields: "derived" },
      }),
    ).rejects.toThrow(/8 search/i);
  });

  it("throws naming the string-filter cap when >8 string filter fields declared", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    const filterFields = Array.from({ length: 9 }, (_, i) => ({
      field: `s${i}`,
      type: "string" as const,
    }));
    await expect(
      t.mutation(api.configSync.applyCollectionConfig, {
        config: { name: "p", searchFields: ["title"], storedFields: "derived", filterFields },
      }),
    ).rejects.toThrow(/8 string filter/i);
  });

  it("throws naming the numeric-filter cap when >8 numeric filter fields declared", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    // SLOT_LIMITS.numFilter = 8; use 9 fields to exceed the cap
    const filterFields = Array.from({ length: 9 }, (_, i) => ({
      field: `n${i}`,
      type: "number" as const,
    }));
    await expect(
      t.mutation(api.configSync.applyCollectionConfig, {
        config: { name: "p", searchFields: ["title"], storedFields: "derived", filterFields },
      }),
    ).rejects.toThrow(/8 numeric filter/i);
  });

  it("createCollection persists slotMap too", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "q",
      searchFields: ["title"],
      storedFields: "derived",
      filterFields: [{ field: "brand", type: "string" }],
    });
    const c = await t.query(api.collections.getCollection, { name: "q" });
    expect(c?.slotMap).toEqual({
      search: { title: "text1" },
      strFilter: { brand: "filt0" },
      numFilter: {},
    });
  });
});
