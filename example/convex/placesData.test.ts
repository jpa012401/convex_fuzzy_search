import { describe, it, expect } from "vitest";
import { generatePlace, generatePlaceRange, CUISINE_OPTIONS } from "./placesData";

describe("placesData", () => {
  it("is deterministic (same index -> same place)", () => {
    expect(generatePlace(0, 1000)).toEqual(generatePlace(0, 1000));
  });
  it("produces geo coords and required fields", () => {
    const p = generatePlace(5, 1_000_000).doc as any;
    expect(typeof p.lat).toBe("number");
    expect(typeof p.lng).toBe("number");
    expect(p.lat).toBeGreaterThanOrEqual(-90);
    expect(p.lat).toBeLessThanOrEqual(90);
    expect(typeof p.rating).toBe("number");
    expect(typeof p.openedAt).toBe("number");
    expect(CUISINE_OPTIONS).toContain(p.cuisine);
    expect(p.id).toMatch(/^pl\d{5}$/);
  });
  it("openedAt is before the provided now", () => {
    const now = 1_000_000_000_000;
    const p = generatePlace(3, now).doc as any;
    expect(p.openedAt).toBeLessThanOrEqual(now);
  });
  it("generatePlaceRange returns {id,doc} entries", () => {
    const r = generatePlaceRange(0, 3, 1000);
    expect(r).toHaveLength(3);
    expect(r[0]).toHaveProperty("id");
    expect(r[0]).toHaveProperty("doc");
  });
});
