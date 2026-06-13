import { describe, it, expect } from "vitest";
import { parseFilter } from "./filter";

const types = { brand: "string", category: "string", price: "number" } as const;
const P = (s: string) => parseFilter(s, types);

describe("parseFilter", () => {
  it("exact string match", () => {
    const p = P("brand:Aurora");
    expect(p({ brand: "Aurora" })).toBe(true);
    expect(p({ brand: "Nimbus" })).toBe(false);
    expect(p({})).toBe(false);
  });

  it("in-set match", () => {
    const p = P("brand:[Aurora,Nimbus]");
    expect(p({ brand: "Nimbus" })).toBe(true);
    expect(p({ brand: "Vertex" })).toBe(false);
  });

  it("numeric comparators", () => {
    expect(P("price:>100")({ price: 150 })).toBe(true);
    expect(P("price:>100")({ price: 50 })).toBe(false);
    expect(P("price:>=100")({ price: 100 })).toBe(true);
    expect(P("price:<50")({ price: 25 })).toBe(true);
    expect(P("price:<=50")({ price: 50 })).toBe(true);
  });

  it("numeric range (inclusive)", () => {
    const p = P("price:[100..200]");
    expect(p({ price: 100 })).toBe(true);
    expect(p({ price: 200 })).toBe(true);
    expect(p({ price: 250 })).toBe(false);
  });

  it("AND / OR / precedence / parentheses", () => {
    expect(P("brand:Aurora && price:>100")({ brand: "Aurora", price: 150 })).toBe(true);
    expect(P("brand:Aurora && price:>100")({ brand: "Aurora", price: 50 })).toBe(false);
    expect(P("brand:Aurora || brand:Nimbus")({ brand: "Nimbus" })).toBe(true);
    expect(P("brand:Vertex || brand:Aurora && price:>100")({ brand: "Vertex", price: 1 })).toBe(true);
    expect(P("(brand:Aurora || brand:Nimbus) && price:<50")({ brand: "Nimbus", price: 10 })).toBe(true);
    expect(P("(brand:Aurora || brand:Nimbus) && price:<50")({ brand: "Nimbus", price: 99 })).toBe(false);
  });

  it("quoted values with spaces", () => {
    expect(P('brand:"Le Coq"')({ brand: "Le Coq" })).toBe(true);
  });

  it("coerces numeric stored values; missing/non-numeric fails the clause", () => {
    expect(P("price:>10")({ price: "150" })).toBe(true);
    expect(P("price:>10")({})).toBe(false);
    expect(P("price:>10")({ price: "abc" })).toBe(false);
  });

  it("throws on unknown field", () => {
    expect(() => P("color:red")).toThrow(/Unknown filter field: color/);
  });

  it("throws on comparator against a string field", () => {
    expect(() => P("brand:>5")).toThrow(/numeric field/);
  });

  it("throws on malformed syntax", () => {
    expect(() => P("brand:")).toThrow();
    expect(() => P("brand:Aurora &&")).toThrow();
  });
});
