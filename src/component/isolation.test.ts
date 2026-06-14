import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

describe("multi-collection isolation", () => {
  it("search in one collection never returns another's docs", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    for (const name of ["products", "articles"]) {
      await t.mutation(api.collections.createCollection, {
        name,
        searchFields: ["name"],
      });
    }
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "shoe" },
    });
    await t.mutation(api.write.upsert, {
      collection: "articles",
      id: "a1",
      doc: { name: "shoe" },
    });
    const r = await t.query(api.search.search, { collection: "products", q: "shoe" });
    expect(r.found).toBe(1);
    expect(r.out_of).toBe(1);
  });
});
