import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

function t() {
  const c = convexTest(schema, modules);
  registerAggregate(c, "docCount");
  registerAggregate(c, "sortIndex");
  return c;
}

const base = {
  name: "jobs",
  searchFields: ["title"],
  storedFields: ["title", "partnered", "postedAt", "lat", "lng", "category"] as string[],
  sortSpecs: [[{ field: "postedAt", order: "desc" as const }]],
};

describe("rankProfiles validation at createCollection", () => {
  it("accepts a valid profile", async () => {
    const c = t();
    await c.mutation(api.collections.createCollection, {
      ...base,
      rankProfiles: {
        jobsFeed: {
          base: "postedAt:desc",
          window: 300,
          terms: [
            { id: "partner", type: "flag", weight: 3, field: "partnered" },
            { id: "fresh", type: "recencyDecay", weight: 2, field: "postedAt", halfLifeMs: 6.048e8 },
            { id: "near", type: "geoDistance", weight: 2, latField: "lat", lngField: "lng", maxKm: 50 },
            { id: "pref", type: "setBoost", weight: 1.5, field: "category", setKey: "prefCats" },
          ],
        },
      },
    });
    const col = await c.query(api.collections.getCollection, { name: "jobs" });
    expect(col?.rankProfiles?.jobsFeed.base).toBe("postedAt:desc");
  });

  it("rejects a base that is not a declared sortSpec", async () => {
    const c = t();
    await expect(
      c.mutation(api.collections.createCollection, {
        ...base,
        rankProfiles: { p: { base: "price:asc", terms: [] } },
      }),
    ).rejects.toThrow(/base/);
  });

  it("rejects a term field not in storedFields", async () => {
    const c = t();
    await expect(
      c.mutation(api.collections.createCollection, {
        ...base,
        rankProfiles: { p: { base: "postedAt:desc", terms: [{ id: "x", type: "field", weight: 1, field: "salary" }] } },
      }),
    ).rejects.toThrow(/storedFields/);
  });

  it("rejects duplicate term ids", async () => {
    const c = t();
    await expect(
      c.mutation(api.collections.createCollection, {
        ...base,
        rankProfiles: { p: { base: "postedAt:desc", terms: [
          { id: "a", type: "flag", weight: 1, field: "partnered" },
          { id: "a", type: "field", weight: 1, field: "postedAt" },
        ] } },
      }),
    ).rejects.toThrow(/duplicate/i);
  });
});
