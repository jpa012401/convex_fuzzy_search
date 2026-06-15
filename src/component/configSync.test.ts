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
});
