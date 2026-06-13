import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.collections.createCollection, {
    name: "products",
    searchFields: ["name"],
  });
  return t;
}

const termsFor = (t: any) =>
  t.run(async (ctx: any) =>
    ctx.db
      .query("terms")
      .withIndex("by_collection_term", (q: any) => q.eq("collection", "products"))
      .collect(),
  );
const trigramsForTerm = (t: any, term: string) =>
  t.run(async (ctx: any) =>
    ctx.db
      .query("trigrams")
      .withIndex("by_collection_term", (q: any) =>
        q.eq("collection", "products").eq("term", term),
      )
      .collect(),
  );

describe("terms + trigrams maintenance", () => {
  it("upsert creates term rows (docCount 1) and trigram rows", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "running shoe" },
    });
    const terms = await termsFor(t);
    expect(terms.map((x: any) => x.term).sort()).toEqual(["running", "shoe"]);
    expect(terms.every((x: any) => x.docCount === 1)).toBe(true);
    expect((await trigramsForTerm(t, "shoe")).map((x: any) => x.gram).sort()).toEqual(
      ["hoe", "sho"],
    );
  });

  it("a shared term across two docs has docCount 2 and no duplicate trigram rows", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "running shoe" } });
    await t.mutation(api.write.upsert, { collection: "products", id: "p2", doc: { name: "running jacket" } });
    const terms = await termsFor(t);
    const running = terms.find((x: any) => x.term === "running");
    expect(running.docCount).toBe(2);
    expect((await trigramsForTerm(t, "running")).length).toBe(5); // run,unn,nni,nin,ing
  });

  it("re-upsert dropping a term decrements/removes it", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "running shoe" } });
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "running" } });
    const terms = await termsFor(t);
    expect(terms.map((x: any) => x.term).sort()).toEqual(["running"]);
    expect(await trigramsForTerm(t, "shoe")).toEqual([]);
  });

  it("delete removes terms + trigrams when docCount hits 0", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "running shoe" } });
    await t.mutation(api.write.delete, { collection: "products", id: "p1" });
    expect(await termsFor(t)).toEqual([]);
    expect(await trigramsForTerm(t, "running")).toEqual([]);
  });
});
