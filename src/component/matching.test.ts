import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { candidateTermsForToken, EXACT, PREFIX } from "./matching";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "products",
    searchFields: ["name"],
  });
  // terms present: running, runners, shoe, jacket, phone
  await t.mutation(api.write.upsertMany, {
    collection: "products",
    docs: [
      { id: "p1", doc: { name: "running shoe runners" } },
      { id: "p2", doc: { name: "running jacket" } },
      { id: "p3", doc: { name: "phone" } },
    ],
  });
  return t;
}

describe("candidateTermsForToken", () => {
  it("exact match scores EXACT", async () => {
    const t = await setup();
    const m = await t.run(async (ctx: any) =>
      Object.fromEntries((await candidateTermsForToken(ctx, "products", "shoe", false)).candidates),
    );
    // "shoe" appears in 1 document (p1)
    expect(m["shoe"]).toEqual({ score: EXACT, docCount: 1 });
  });

  it("prefix matches only when isLast", async () => {
    const t = await setup();
    const last = await t.run(async (ctx: any) =>
      Object.fromEntries((await candidateTermsForToken(ctx, "products", "run", true)).candidates),
    );
    expect(Object.keys(last).sort()).toEqual(["runners", "running"]);
    // "running" appears in 2 documents (p1, p2); "runners" appears in 1 (p1)
    expect(last["running"]).toEqual({ score: PREFIX, docCount: 2 });

    const notLast = await t.run(async (ctx: any) =>
      Object.fromEntries((await candidateTermsForToken(ctx, "products", "run", false)).candidates),
    );
    // "run" is not a term; len 3 -> no fuzzy; not last -> no prefix
    expect(Object.keys(notLast)).toEqual([]);
  });

  it("fuzzy matches a typo within budget and scores below exact", async () => {
    const t = await setup();
    // "runing" is edit-distance 1 from "running" (token len 6 -> budget 1).
    const m = await t.run(async (ctx: any) =>
      Object.fromEntries((await candidateTermsForToken(ctx, "products", "runing", false)).candidates),
    );
    // "running" appears in 2 documents (p1, p2); typo score is between 0 and EXACT
    expect(m["running"].score).toBeGreaterThan(0);
    expect(m["running"].score).toBeLessThan(EXACT);
    expect(m["running"].docCount).toBe(2);
  });

  it("caps hot prefix candidate discovery and reports truncation", async () => {
    const t = await setup();
    await t.mutation(api.write.upsertMany, {
      collection: "products",
      docs: Array.from({ length: 8 }, (_, i) => ({
        id: `hot-${i}`,
        doc: { name: `runprefix${i}` },
      })),
    });
    const r = await t.run(async (ctx: any) => {
      const result = await candidateTermsForToken(ctx, "products", "run", true, 3);
      return { size: result.candidates.size, truncated: result.truncated };
    });
    expect(r.size).toBeLessThanOrEqual(3);
    expect(r.truncated).toBe(true);
  });
});
