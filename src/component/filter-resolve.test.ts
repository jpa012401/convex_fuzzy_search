import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
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
    [...(await resolveAstToDocIds(ctx, "shop", parseFilterAst(expr, types)))],
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
});
