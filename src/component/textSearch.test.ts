/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { matchTokens } from "./textSearch";

const modules = import.meta.glob("./**/*.ts");

async function seeded() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
  });
  const docs = [
    { id: "1", doc: { name: "waterproof shoe" } },
    { id: "2", doc: { name: "running shoe" } },
    { id: "3", doc: { name: "leather shoe" } },
  ];
  for (const d of docs) await t.mutation(api.write.upsert, { collection: "shop", ...d });
  return t;
}

describe("matchTokens", () => {
  it("multi-term AND drives from the rare token and returns the intersection", async () => {
    const t = await seeded();
    const r = await t.run(async (ctx: any) => {
      const res = await matchTokens(ctx, "shop", ["waterproof", "shoe"], undefined);
      return {
        scoreByIdEntries: [...res.scoreById.entries()],
        matchedTerms: [...res.matchedTerms],
        truncated: res.truncated,
        singleExactTerm: res.singleExactTerm,
      };
    });
    const scoreById = new Map<string, number>(r.scoreByIdEntries as [string, number][]);
    const matchedTerms = new Set<string>(r.matchedTerms as string[]);
    expect([...scoreById.keys()].sort()).toEqual(["1"]);
    expect(scoreById.get("1")).toBe(6); // exact(3) + exact(3)
    expect(r.truncated).toBe(false);
    expect(r.singleExactTerm).toBeNull();
    expect(matchedTerms.has("waterproof")).toBe(true);
    expect(matchedTerms.has("shoe")).toBe(true);
  });

  it("single common term matches all docs containing it", async () => {
    const t = await seeded();
    const r = await t.run(async (ctx: any) => {
      const res = await matchTokens(ctx, "shop", ["shoe"], undefined);
      return {
        scoreByIdKeys: [...res.scoreById.keys()].sort(),
        singleExactTerm: res.singleExactTerm,
        truncated: res.truncated,
      };
    });
    expect(r.scoreByIdKeys).toEqual(["1", "2", "3"]);
    expect(r.singleExactTerm).toBe("shoe");
    expect(r.truncated).toBe(false);
  });

  it("respects queryBy (no postings in an excluded field -> no match)", async () => {
    const t = await seeded();
    const r = await t.run(async (ctx: any) => {
      const res = await matchTokens(ctx, "shop", ["shoe"], ["title"]);
      return { scoreByIdSize: res.scoreById.size };
    });
    expect(r.scoreByIdSize).toBe(0);
  });

  it("a token with no candidate terms yields an empty AND result", async () => {
    const t = await seeded();
    const r = await t.run(async (ctx: any) => {
      const res = await matchTokens(ctx, "shop", ["shoe", "zzzzzzzz"], undefined);
      return { scoreByIdSize: res.scoreById.size };
    });
    expect(r.scoreByIdSize).toBe(0);
  });

  it("budget cap truncates the driver scan and flags it", async () => {
    const t = await seeded();
    const r = await t.run(async (ctx: any) => {
      const res = await matchTokens(ctx, "shop", ["shoe"], undefined, 1);
      return {
        truncated: res.truncated,
        scoreByIdSize: res.scoreById.size,
        singleExactTerm: res.singleExactTerm,
      };
    });
    expect(r.truncated).toBe(true);
    expect(r.scoreByIdSize).toBeLessThanOrEqual(1);
    expect(r.singleExactTerm).toBe("shoe");
  });
});
