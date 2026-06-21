import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { FILTER_SLOTS, slotMapValidator } from "./schema";
const modules = import.meta.glob("./**/*.ts");

describe("searchDocs generic-slot schema", () => {
  it("exposes the FINAL filter-slot const used by every search index", () => {
    expect(FILTER_SLOTS).toEqual([
      "collection",
      "filt0", "filt1", "filt2", "filt3", "filt4", "filt5", "filt6", "filt7",
      "numF0", "numF1", "numF2", "numF3", "numF4", "numF5", "numF6", "numF7",
    ]);
  });

  it("defines a searchDocs table with 9 search indexes s0..s8", () => {
    const tables = (schema as unknown as { tables: Record<string, unknown> }).tables;
    expect(tables.searchDocs).toBeDefined();
    const exported = (
      schema.tables.searchDocs as unknown as {
        export: () => { searchIndexes: { indexDescriptor: string; searchField: string; filterFields: string[] }[]; indexes: { indexDescriptor: string }[] };
      }
    ).export();
    const searchNames = exported.searchIndexes.map((i) => i.indexDescriptor).sort();
    expect(searchNames).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]);
    for (const idx of exported.searchIndexes) {
      const n = Number(idx.indexDescriptor.slice(1));
      expect(idx.searchField).toBe(`text${n}`);
      expect(idx.filterFields).toEqual([...FILTER_SLOTS]);
    }
    expect(exported.indexes.map((i) => i.indexDescriptor)).toContain("by_collection_doc");
  });

  it("exposes slotMapValidator with search/strFilter/numFilter records", () => {
    expect(slotMapValidator.kind).toBe("object");
    expect(Object.keys((slotMapValidator as unknown as { fields: Record<string, unknown> }).fields).sort())
      .toEqual(["numFilter", "search", "strFilter"]);
  });

  it("registers the component schema under convex-test", () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");
    expect(t).toBeDefined();
  });
});
