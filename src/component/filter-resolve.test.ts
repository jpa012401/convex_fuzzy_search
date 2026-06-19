import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { parseFilterAst, resolveAstToDocIds } from "./filter";

const modules = import.meta.glob("./**/*.ts");
const types = { brand: "string", price: "number" } as const;

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
    filterFields: [
      { field: "brand", type: "string" as const },
      { field: "price", type: "number" as const },
    ],
  });
  const docs = [
    { id: "a", brand: "Aurora", price: 90 },
    { id: "b", brand: "Aurora", price: 110 },
    { id: "c", brand: "Nimbus", price: 150 },
  ];
  for (const d of docs) {
    await t.mutation(api.write.upsert, { collection: "shop", id: d.id, doc: { name: d.id, brand: d.brand, price: d.price } });
  }
  return t;
}

// Resolve to the set of docIds by mapping docKeys -> documents.by_collection_docKey.
const resolveIds = async (t: any, expr: string): Promise<Set<string>> => {
  const ids: string[] = await t.run(async (ctx: any) => {
    const r = await resolveAstToDocIds(ctx, "shop", parseFilterAst(expr, types));
    const out: string[] = [];
    for (const k of r.docKeys) {
      const doc = await ctx.db
        .query("documents")
        .withIndex("by_collection_docKey", (q: any) => q.eq("collection", "shop").eq("docKey", k))
        .unique();
      if (doc) out.push(doc.docId);
    }
    return out;
  });
  return new Set(ids);
};
const sorted = (s: Set<string>) => [...s].sort();

describe("resolveAstToDocIds (filterPostings-backed)", () => {
  it("exact, in-set, comparator, range, AND, OR", async () => {
    const t = await setup();
    expect(sorted(await resolveIds(t, "brand:Aurora"))).toEqual(["a", "b"]);
    expect(sorted(await resolveIds(t, "brand:[Aurora,Nimbus]"))).toEqual(["a", "b", "c"]);
    expect(sorted(await resolveIds(t, "price:>100"))).toEqual(["b", "c"]);
    expect(sorted(await resolveIds(t, "price:[100..200]"))).toEqual(["b", "c"]);
    expect(sorted(await resolveIds(t, "brand:Aurora && price:>100"))).toEqual(["b"]);
    expect(sorted(await resolveIds(t, "brand:Nimbus || price:<100"))).toEqual(["a", "c"]);
  });

  it("price:>100 excludes a doc priced exactly 100 (strict-comparator boundary)", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "shop",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [
        { field: "brand", type: "string" as const },
        { field: "price", type: "number" as const },
      ],
    });
    await t.mutation(api.write.upsert, { collection: "shop", id: "exact100", doc: { name: "exact100", brand: "X", price: 100 } });
    await t.mutation(api.write.upsert, { collection: "shop", id: "above100", doc: { name: "above100", brand: "X", price: 101 } });
    // price:>100 must exclude exactly-100 and include 101
    const ids: string[] = await t.run(async (ctx: any) => {
      const r = await resolveAstToDocIds(ctx, "shop", parseFilterAst("price:>100", { price: "number" }));
      const out: string[] = [];
      for (const k of r.docKeys) {
        const doc = await ctx.db
          .query("documents")
          .withIndex("by_collection_docKey", (q: any) => q.eq("collection", "shop").eq("docKey", k))
          .unique();
        if (doc) out.push(doc.docId);
      }
      return out;
    });
    const result = new Set(ids);
    expect(result.has("exact100")).toBe(false);
    expect(result.has("above100")).toBe(true);
  });

  it("caps broad reads and reports truncation (on docKeys)", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "shop", searchFields: ["name"], storedFields: "all",
      filterFields: [{ field: "brand", type: "string" as const }],
    });
    for (let i = 0; i < 8; i++) {
      await t.mutation(api.write.upsert, { collection: "shop", id: `p${i}`, doc: { name: "n", brand: "Aurora" } });
    }
    const result = await t.run(async (ctx: any) => {
      const r = await resolveAstToDocIds(ctx, "shop", parseFilterAst("brand:Aurora", { brand: "string" }), 3);
      return { size: r.docKeys.size, truncated: r.truncated };
    });
    expect(result.size).toBeLessThanOrEqual(3);
    expect(result.truncated).toBe(true);
  });
});
