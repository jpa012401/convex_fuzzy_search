import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { parseFilterAst, resolveAstToDocIds } from "./filter";

const modules = import.meta.glob("./**/*.ts");
const types = { brand: "string", price: "number" } as const;

async function seedFilters(t: any) {
  await t.run(async (ctx: any) => {
    const rows = [
      { docId: "a", brand: "Aurora", price: 90 },
      { docId: "b", brand: "Aurora", price: 110 },
      { docId: "c", brand: "Nimbus", price: 150 },
    ];
    for (const r of rows) {
      await ctx.db.insert("filters", { collection: "shop", field: "brand", docId: r.docId, strVal: r.brand });
      await ctx.db.insert("filters", { collection: "shop", field: "price", docId: r.docId, numVal: r.price });
    }
  });
}
const resolve = async (t: any, expr: string): Promise<Set<string>> => {
  const ids: string[] = await t.run(async (ctx: any) =>
    [...(await resolveAstToDocIds(ctx, "shop", parseFilterAst(expr, types))).ids],
  );
  return new Set(ids);
};
const sorted = (s: Set<string>) => [...s].sort();

describe("resolveAstToDocIds", () => {
  it("exact, in-set, comparator, range, AND, OR", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await seedFilters(t);
    expect(sorted(await resolve(t, "brand:Aurora"))).toEqual(["a", "b"]);
    expect(sorted(await resolve(t, "brand:[Aurora,Nimbus]"))).toEqual(["a", "b", "c"]);
    expect(sorted(await resolve(t, "price:>100"))).toEqual(["b", "c"]);
    expect(sorted(await resolve(t, "price:[100..200]"))).toEqual(["b", "c"]);
    expect(sorted(await resolve(t, "brand:Aurora && price:>100"))).toEqual(["b"]);
    expect(sorted(await resolve(t, "brand:Nimbus || price:<100"))).toEqual(["a", "c"]);
  });

  it("comparators exclude rows with no numeric value (undefined numVal)", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await seedFilters(t); // a:90, b:110, c:150 (all numeric)
    // Insert a row under the numeric field 'price' with NO numVal (strVal only),
    // simulating a non-coercible/missing value that must NOT match a comparator.
    await t.run(async (ctx: any) => {
      await ctx.db.insert("filters", { collection: "shop", field: "price", docId: "x", strVal: "n/a" });
    });
    // "x" has undefined numVal -> must be excluded from < and <=.
    expect(sorted(await resolve(t, "price:<100"))).toEqual(["a"]);
    expect(sorted(await resolve(t, "price:<=90"))).toEqual(["a"]);
  });

  it("caps broad filter reads and reports truncation", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.run(async (ctx: any) => {
      for (let i = 0; i < 8; i++) {
        await ctx.db.insert("filters", {
          collection: "shop",
          field: "brand",
          docId: `p${i}`,
          strVal: "Aurora",
        });
      }
    });
    const result = await t.run(async (ctx: any) => {
      const resolved = await resolveAstToDocIds(ctx, "shop", parseFilterAst("brand:Aurora", types), 3);
      return { size: resolved.ids.size, truncated: resolved.truncated };
    });
    expect(result.size).toBeLessThanOrEqual(3);
    expect(result.truncated).toBe(true);
  });

  it("resolves a filter to docKeys and reports complete", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "fr",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }],
    });
    await t.mutation(api.write.upsert, { collection: "fr", id: "a", doc: { name: "x", brand: "Acme" } });
    await t.mutation(api.write.upsert, { collection: "fr", id: "b", doc: { name: "y", brand: "Acme" } });
    const res = await t.run(async (ctx) => {
      const { resolveAstToDocIds, parseFilterAst } = await import("./filter");
      const r = await resolveAstToDocIds(ctx, "fr", parseFilterAst("brand:Acme", { brand: "string" }));
      return { docKeysSize: r.docKeys.size, complete: r.complete, idsSize: r.ids.size };
    });
    expect(res.docKeysSize).toBe(2);
    expect(res.complete).toBe(true);
    expect(res.idsSize).toBe(2);
  });
});
