import { describe, it, expect } from "vitest";
import { projectToSlots } from "./searchWrite";
import { assignSlots } from "./slotMap";

const baseCol = {
  searchFields: ["title", "body"],
  storedFields: ["title", "brand", "price"] as string[],
  filterFields: [
    { field: "brand", type: "string" as const },
    { field: "price", type: "number" as const },
  ],
};

function colWithMap(extra: Partial<typeof baseCol> = {}) {
  const col = { ...baseCol, ...extra };
  return { ...col, slotMap: assignSlots(col) };
}

describe("projectToSlots", () => {
  it("text0 = tokenized+space-joined concatenation of ALL searchFields", () => {
    const col = colWithMap();
    const row = projectToSlots(
      { title: "Red Shoe", body: "Running Shoe!", brand: "Acme", price: 50 },
      col,
    );
    // tokenize lowercases + strips punctuation; order = searchFields order
    expect(row.text0).toBe("red shoe running shoe");
  });

  it("textN holds the RAW text of each mapped searchField", () => {
    const col = colWithMap();
    const titleSlot = col.slotMap.search["title"]; // e.g. "text1"
    const bodySlot = col.slotMap.search["body"];   // e.g. "text2"
    const row = projectToSlots(
      { title: "Red Shoe", body: "Running Shoe!", brand: "Acme", price: 50 },
      col,
    ) as Record<string, unknown>;
    expect(row[titleSlot]).toBe("Red Shoe");
    expect(row[bodySlot]).toBe("Running Shoe!");
  });

  it("filtN = String(value), numFN = Number(value)", () => {
    const col = colWithMap();
    const brandSlot = col.slotMap.strFilter["brand"]; // "filt0"
    const priceSlot = col.slotMap.numFilter["price"]; // "numF0"
    const row = projectToSlots(
      { title: "x", body: "y", brand: "Acme", price: 50 },
      col,
    ) as Record<string, unknown>;
    expect(row[brandSlot]).toBe("Acme");
    expect(row[priceSlot]).toBe(50);
  });

  it("skips numeric filter when value coerces to NaN", () => {
    const col = colWithMap();
    const priceSlot = col.slotMap.numFilter["price"];
    const row = projectToSlots(
      { title: "x", body: "y", brand: "Acme", price: "not-a-number" },
      col,
    ) as Record<string, unknown>;
    expect(priceSlot in row).toBe(false);
  });

  it("omits slots for absent / null fields", () => {
    const col = colWithMap();
    const row = projectToSlots({ title: "only title" }, col) as Record<string, unknown>;
    expect(row.text0).toBe("only title");
    expect(col.slotMap.search["body"] in row).toBe(false);
    expect(col.slotMap.strFilter["brand"] in row).toBe(false);
    expect(col.slotMap.numFilter["price"] in row).toBe(false);
  });

  it("stored is the storedFields projection (explicit list keeps only listed keys)", () => {
    const col = colWithMap();
    const row = projectToSlots(
      { title: "Red Shoe", body: "running", brand: "Acme", price: 50, secret: "x" },
      col,
    );
    expect(row.stored).toEqual({ title: "Red Shoe", brand: "Acme", price: 50 });
  });

  it("falls back to assignSlots(col) when slotMap is absent (F9 belt-and-suspenders)", () => {
    const colNoMap = { ...baseCol }; // no slotMap
    const row = projectToSlots(
      { title: "Red Shoe", body: "running", brand: "Acme", price: 50 },
      colNoMap,
    );
    expect(row.text0).toBe("red shoe running");
    // first-declared -> lowest free slot: title->text1, brand->filt0, price->numF0
    expect((row as Record<string, unknown>)["text1"]).toBe("Red Shoe");
    expect((row as Record<string, unknown>)["filt0"]).toBe("Acme");
    expect((row as Record<string, unknown>)["numF0"]).toBe(50);
  });
});
