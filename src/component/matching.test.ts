import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { candidateTermsForToken, EXACT, PREFIX } from "./matching";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
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
      Object.fromEntries(await candidateTermsForToken(ctx, "products", "shoe", false)),
    );
    expect(m["shoe"]).toBe(EXACT);
  });

  it("prefix matches only when isLast", async () => {
    const t = await setup();
    const last = await t.run(async (ctx: any) =>
      Object.fromEntries(await candidateTermsForToken(ctx, "products", "run", true)),
    );
    expect(Object.keys(last).sort()).toEqual(["runners", "running"]);
    expect(last["running"]).toBe(PREFIX);

    const notLast = await t.run(async (ctx: any) =>
      Object.fromEntries(await candidateTermsForToken(ctx, "products", "run", false)),
    );
    // "run" is not a term; len 3 -> no fuzzy; not last -> no prefix
    expect(Object.keys(notLast)).toEqual([]);
  });

  it("fuzzy matches a typo within budget and scores below exact", async () => {
    const t = await setup();
    // "runing" is edit-distance 1 from "running" (token len 6 -> budget 1).
    const m = await t.run(async (ctx: any) =>
      Object.fromEntries(await candidateTermsForToken(ctx, "products", "runing", false)),
    );
    expect(m["running"]).toBeGreaterThan(0);
    expect(m["running"]).toBeLessThan(EXACT);
  });
});
