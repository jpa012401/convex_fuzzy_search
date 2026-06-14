import { describe, it, expect } from "vitest";
import { canonicalSpecId, encodeKey, specMatches } from "./sortIndex";

describe("sortIndex pure helpers", () => {
  it("canonicalSpecId joins field:order in order", () => {
    expect(canonicalSpecId([{ field: "price", order: "asc" }])).toBe("price:asc");
    expect(
      canonicalSpecId([
        { field: "rating", order: "desc" },
        { field: "price", order: "asc" },
      ]),
    ).toBe("rating:desc,price:asc");
  });

  it("encodeKey negates desc, keeps asc, missing/NaN -> 0", () => {
    expect(encodeKey({ price: 10, rating: 4 }, [{ field: "price", order: "asc" }])).toEqual([10]);
    expect(
      encodeKey({ price: 10, rating: 4 }, [
        { field: "rating", order: "desc" },
        { field: "price", order: "asc" },
      ]),
    ).toEqual([-4, 10]);
    expect(encodeKey({}, [{ field: "price", order: "asc" }])).toEqual([0]);
    expect(encodeKey({ price: "abc" }, [{ field: "price", order: "asc" }])).toEqual([0]);
  });

  it("specMatches returns the exact declared spec or null", () => {
    const specs = [
      [{ field: "price", order: "asc" as const }],
      [
        { field: "rating", order: "desc" as const },
        { field: "price", order: "asc" as const },
      ],
    ];
    expect(specMatches([{ field: "price", order: "asc" }], specs)).toEqual([
      { field: "price", order: "asc" },
    ]);
    expect(specMatches([{ field: "price", order: "desc" }], specs)).toBeNull();
    expect(
      specMatches(
        [
          { field: "rating", order: "desc" },
          { field: "price", order: "asc" },
        ],
        specs,
      ),
    ).toEqual([
      { field: "rating", order: "desc" },
      { field: "price", order: "asc" },
    ]);
    expect(specMatches(undefined, specs)).toBeNull();
    expect(specMatches([], specs)).toBeNull();
  });
});
