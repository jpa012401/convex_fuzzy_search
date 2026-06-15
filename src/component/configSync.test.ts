import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob("./**/*.ts");

describe("applyCollectionConfig", () => {
  it("creates a collection row from config", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "p", searchFields: ["name"], storedFields: "derived" },
    });
    const c = await t.query(api.collections.getCollection, { name: "p" });
    expect(c).toMatchObject({ name: "p", storedFields: "derived" });
  });

  it("updates metadata in place without touching pendingFields", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.configSync.applyCollectionConfig, { config: { name: "p", searchFields: ["name"], storedFields: "derived" } });
    await t.mutation(api.configSync.applyCollectionConfig, { config: { name: "p", searchFields: ["name", "desc"], storedFields: "derived" } });
    const c = await t.query(api.collections.getCollection, { name: "p" });
    expect(c?.searchFields).toEqual(["name", "desc"]);
    expect(c?.pendingFields ?? []).toEqual([]);
  });

  it("records pending fields when a filter field is added", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.configSync.applyCollectionConfig, { config: { name: "p", searchFields: ["name"], storedFields: "derived" } });
    await t.mutation(api.configSync.applyCollectionConfig, { config: { name: "p", searchFields: ["name"], storedFields: "derived", filterFields: [{ field: "brand", type: "string" }] } });
    const c = await t.query(api.collections.getCollection, { name: "p" });
    expect(c?.pendingFields).toContain("brand");
  });

  it("accumulates and dedups pending fields across two structural adds", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.configSync.applyCollectionConfig, { config: { name: "p", searchFields: ["n"], storedFields: "derived" } });
    const r1 = await t.mutation(api.configSync.applyCollectionConfig, { config: { name: "p", searchFields: ["n"], storedFields: "derived", filterFields: [{ field: "brand", type: "string" }] } });
    expect(r1).toMatchObject({ kind: "update" });
    expect(r1.pendingFields).toContain("brand");
    const r2 = await t.mutation(api.configSync.applyCollectionConfig, { config: { name: "p", searchFields: ["n"], storedFields: "derived", filterFields: [{ field: "brand", type: "string" }], facetFields: ["size"] } });
    expect(r2.pendingFields.sort()).toEqual(["brand", "size"].sort()); // accumulated, deduped
  });

  it("re-applying identical config adds no new pending fields (idempotent)", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    // Start from an existing collection that already has its structural fields,
    // so a re-apply of the SAME config has nothing structurally new to flag.
    await t.mutation(api.collections.createCollection, {
      name: "p",
      searchFields: ["n"],
      storedFields: "derived",
      filterFields: [{ field: "brand", type: "string" }],
      facetFields: ["size"],
      sortSpecs: [[{ field: "price", order: "asc" }]],
    });
    const config = {
      name: "p",
      searchFields: ["n"],
      storedFields: "derived" as const,
      filterFields: [{ field: "brand", type: "string" as const }],
      facetFields: ["size"],
      sortSpecs: [[{ field: "price", order: "asc" as const }]],
    };
    const r1 = await t.mutation(api.configSync.applyCollectionConfig, { config });
    const r2 = await t.mutation(api.configSync.applyCollectionConfig, { config });
    expect(r1.kind).toBe("update");
    expect(r2.kind).toBe("update");
    // Nothing structurally new vs the existing row on either apply.
    expect(r1.pendingFields).toEqual([]);
    expect(r2.pendingFields).toEqual([]);
  });
});
