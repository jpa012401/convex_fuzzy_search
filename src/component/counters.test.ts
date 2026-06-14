import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { collectionCount, pageDocIds, addDoc, removeDoc } from "./counters";

const modules = import.meta.glob("./**/*.ts");

describe("counters", () => {
  it("counts, pages, and decrements per collection namespace", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.run(async (ctx) => {
      await addDoc(ctx, "c1", "a");
      await addDoc(ctx, "c1", "b");
      await addDoc(ctx, "c1", "a"); // idempotent
      await addDoc(ctx, "c2", "z");
    });
    expect(await t.run((ctx) => collectionCount(ctx, "c1"))).toBe(2);
    expect(await t.run((ctx) => collectionCount(ctx, "c2"))).toBe(1);
    expect(await t.run((ctx) => pageDocIds(ctx, "c1", 0, 1))).toEqual(["a"]);
    expect(await t.run((ctx) => pageDocIds(ctx, "c1", 1, 5))).toEqual(["b"]);
    await t.run((ctx) => removeDoc(ctx, "c1", "a"));
    expect(await t.run((ctx) => collectionCount(ctx, "c1"))).toBe(1);
    await t.run((ctx) => removeDoc(ctx, "c1", "missing")); // idempotent, no throw
  });
});
