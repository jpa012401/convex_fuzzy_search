# Phase 2 — Filtering + Faceting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `filter_by` structured filtering (full boolean grammar) and query-scoped `facet_counts` to search, evaluated in-memory over the documents search already loads — no new tables, no write-path changes.

**Architecture:** A pure `filter.ts` parses a `filter_by` string into a `(storedDoc) => boolean` predicate using declared field types. The `collections` row gains optional `filterFields` (with types) and `facetFields`, validated at `createCollection` to be within `storedFields`. `search` applies the predicate to its already-loaded result set, then tallies facet counts over that set.

**Tech Stack:** Convex (component), TypeScript (`verbatimModuleSyntax` ON — `import type`), convex-test + Vitest. Tests COLOCATED (`src/component/*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-06-13-typesense-convex-phase2-design.md`

**Repo conventions:** colocated tests import `schema` from `./schema`, `api` from `./_generated/api`, glob `import.meta.glob("./**/*.ts")`. Run codegen after schema changes (`npm run build:codegen`). Deployment configured (`.env.local`).

---

## File Structure

```
src/component/filter.ts        # NEW: parseFilter(input, fieldTypes) -> Predicate (pure)
src/component/schema.ts         # collections gains optional filterFields, facetFields
src/component/collections.ts    # createCollection accepts + validates filter/facet fields
src/component/search.ts         # apply filter predicate; compute facet_counts
src/client/index.ts             # search/createCollection arg passthrough
example/convex/products.ts      # declare filter/facet fields; passthrough args
example/src/*                   # active facet sidebar
README.md
```

---

## Task 1: `filter.ts` — pure filter_by parser

**Files:** Create `src/component/filter.ts`; Test `src/component/filter.test.ts`.

- [ ] **Step 1: Write failing test `src/component/filter.test.ts`**

```ts
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
    // && binds tighter than ||
    expect(P("brand:Vertex || brand:Aurora && price:>100")({ brand: "Vertex", price: 1 })).toBe(true);
    expect(P("(brand:Aurora || brand:Nimbus) && price:<50")({ brand: "Nimbus", price: 10 })).toBe(true);
    expect(P("(brand:Aurora || brand:Nimbus) && price:<50")({ brand: "Nimbus", price: 99 })).toBe(false);
  });

  it("quoted values with spaces", () => {
    expect(P('brand:"Le Coq"')({ brand: "Le Coq" })).toBe(true);
  });

  it("coerces numeric stored values; missing/non-numeric fails the clause", () => {
    expect(P("price:>10")({ price: "150" })).toBe(true); // stored as string, coerced
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
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/filter.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/component/filter.ts`**

```ts
export type Predicate = (stored: Record<string, unknown>) => boolean;
export type FieldType = "string" | "number";

type Tok = { t: string; v?: string };

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const special = new Set([" ", "\t", "\n", "(", ")", "[", "]", ",", ":", ">", "<", '"']);
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    const two = s.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === ".." || two === ">=" || two === "<=") {
      toks.push({ t: two });
      i += 2;
      continue;
    }
    if ("()[],:><".includes(c)) { toks.push({ t: c }); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let val = "";
      while (j < s.length && s[j] !== '"') { val += s[j]; j++; }
      if (j >= s.length) throw new Error("Unterminated quote in filter");
      toks.push({ t: "val", v: val });
      i = j + 1;
      continue;
    }
    // bareword
    let j = i;
    let val = "";
    while (j < s.length) {
      if (special.has(s[j])) break;
      const t2 = s.slice(j, j + 2);
      if (t2 === "&&" || t2 === "||" || t2 === "..") break;
      val += s[j];
      j++;
    }
    if (val === "") throw new Error(`Unexpected character '${s[i]}' in filter`);
    toks.push({ t: "val", v: val });
    i = j;
  }
  return toks;
}

export function parseFilter(
  input: string,
  fieldTypes: Record<string, FieldType>,
): Predicate {
  const toks = tokenize(input);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (t: string) => {
    const x = next();
    if (!x || x.t !== t) throw new Error(`Expected '${t}' in filter`);
    return x;
  };
  const getVal = (): string => {
    const x = next();
    if (!x || x.t !== "val") throw new Error("Expected a value in filter");
    return x.v!;
  };

  function parseExpr(): Predicate {
    let left = parseAnd();
    while (peek() && peek().t === "||") {
      next();
      const right = parseAnd();
      const l = left, r = right;
      left = (d) => l(d) || r(d);
    }
    return left;
  }
  function parseAnd(): Predicate {
    let left = parseUnary();
    while (peek() && peek().t === "&&") {
      next();
      const right = parseUnary();
      const l = left, r = right;
      left = (d) => l(d) && r(d);
    }
    return left;
  }
  function parseUnary(): Predicate {
    if (peek() && peek().t === "(") {
      next();
      const e = parseExpr();
      expect(")");
      return e;
    }
    return parseClause();
  }
  function parseClause(): Predicate {
    const f = next();
    if (!f || f.t !== "val") throw new Error("Expected a field name in filter");
    const field = f.v!;
    const type = fieldTypes[field];
    if (!type) throw new Error(`Unknown filter field: ${field}`);
    expect(":");
    return parseMatcher(field, type);
  }
  function parseMatcher(field: string, type: FieldType): Predicate {
    const p = peek();
    if (p && p.t === "[") {
      next();
      const first = getVal();
      if (peek() && peek().t === "..") {
        next();
        const second = getVal();
        expect("]");
        if (type !== "number") throw new Error(`Range filter requires a numeric field: ${field}`);
        const lo = Number(first), hi = Number(second);
        if (Number.isNaN(lo) || Number.isNaN(hi)) throw new Error(`Invalid numeric range for ${field}`);
        return (d) => {
          const v = Number(d[field]);
          return !Number.isNaN(v) && v >= lo && v <= hi;
        };
      }
      const vals = [first];
      while (peek() && peek().t === ",") { next(); vals.push(getVal()); }
      expect("]");
      if (type === "number") {
        const nums = vals.map(Number);
        return (d) => {
          const v = Number(d[field]);
          return !Number.isNaN(v) && nums.includes(v);
        };
      }
      return (d) => d[field] !== undefined && vals.includes(String(d[field]));
    }
    if (p && (p.t === ">" || p.t === ">=" || p.t === "<" || p.t === "<=")) {
      const op = next().t;
      if (type !== "number") throw new Error(`Comparator filter requires a numeric field: ${field}`);
      const num = Number(getVal());
      if (Number.isNaN(num)) throw new Error(`Invalid number in filter for ${field}`);
      return (d) => {
        const v = Number(d[field]);
        if (Number.isNaN(v)) return false;
        return op === ">" ? v > num : op === ">=" ? v >= num : op === "<" ? v < num : v <= num;
      };
    }
    // exact
    const val = getVal();
    if (type === "number") {
      const n = Number(val);
      return (d) => {
        const v = Number(d[field]);
        return !Number.isNaN(v) && v === n;
      };
    }
    return (d) => d[field] !== undefined && String(d[field]) === val;
  }

  const pred = parseExpr();
  if (pos !== toks.length) throw new Error("Unexpected trailing tokens in filter");
  return pred;
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run src/component/filter.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add src/component/filter.ts src/component/filter.test.ts
git commit -m "feat: pure filter_by parser (full boolean grammar)"
```

---

## Task 2: Collection config — `filterFields` + `facetFields` with validation

**Files:** Modify `src/component/schema.ts`, `src/component/collections.ts`; Test `src/component/collections.test.ts` (append).

- [ ] **Step 1: Append failing tests to `src/component/collections.test.ts`**

```ts
describe("filter/facet field config", () => {
  it("stores filterFields and facetFields", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
      ],
      facetFields: ["brand"],
    });
    const c = await t.query(api.collections.getCollection, { name: "products" });
    expect(c).toMatchObject({
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
      ],
      facetFields: ["brand"],
    });
  });

  it("rejects filter/facet fields not covered by a storedFields projection", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.collections.createCollection, {
        name: "products",
        searchFields: ["name"],
        storedFields: ["name"], // does not include brand
        filterFields: [{ field: "brand", type: "string" }],
      }),
    ).rejects.toThrow(/storedFields/);
    await expect(
      t.mutation(api.collections.createCollection, {
        name: "p2",
        searchFields: ["name"],
        storedFields: ["name"],
        facetFields: ["brand"],
      }),
    ).rejects.toThrow(/storedFields/);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/collections.test.ts`
Expected: FAIL — args not accepted / not validated.

- [ ] **Step 3: Add columns to `collections` in `src/component/schema.ts`**

Change the `collections` table definition to:

```ts
  collections: defineTable({
    name: v.string(),
    searchFields: v.array(v.string()),
    storedFields: v.union(v.literal("all"), v.array(v.string())),
    filterFields: v.optional(
      v.array(
        v.object({
          field: v.string(),
          type: v.union(v.literal("string"), v.literal("number")),
        }),
      ),
    ),
    facetFields: v.optional(v.array(v.string())),
  }).index("by_name", ["name"]),
```

- [ ] **Step 4: Extend `createCollection` in `src/component/collections.ts`**

Replace the `createCollection` mutation with:

```ts
export const createCollection = mutation({
  args: {
    name: v.string(),
    searchFields: v.array(v.string()),
    storedFields: v.optional(v.union(v.literal("all"), v.array(v.string()))),
    filterFields: v.optional(
      v.array(
        v.object({
          field: v.string(),
          type: v.union(v.literal("string"), v.literal("number")),
        }),
      ),
    ),
    facetFields: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const existing = await loadCollection(ctx, args.name);
    if (existing !== null) {
      throw new Error(`Collection "${args.name}" already exists`);
    }
    const storedFields = args.storedFields ?? "all";
    if (storedFields !== "all") {
      const persisted = new Set(storedFields);
      for (const f of args.filterFields ?? []) {
        if (!persisted.has(f.field)) {
          throw new Error(
            `filterFields field "${f.field}" must be included in storedFields`,
          );
        }
      }
      for (const f of args.facetFields ?? []) {
        if (!persisted.has(f)) {
          throw new Error(
            `facetFields field "${f}" must be included in storedFields`,
          );
        }
      }
    }
    await ctx.db.insert("collections", {
      name: args.name,
      searchFields: args.searchFields,
      storedFields,
      filterFields: args.filterFields,
      facetFields: args.facetFields,
    });
  },
});
```

- [ ] **Step 5: Regenerate + run tests (no regressions)**

Run: `npm run build:codegen && npx vitest run src/component/collections.test.ts`
Expected: PASS (existing collection tests + 2 new).

- [ ] **Step 6: Commit**

```bash
git add src/component/schema.ts src/component/collections.ts src/component/collections.test.ts src/component/_generated
git commit -m "feat: collection filterFields + facetFields config with validation"
```

---

## Task 3: Search integration — apply filter + compute facet_counts

**Files:** Modify `src/component/search.ts`; Test `src/component/search.test.ts` (append).

- [ ] **Step 1: Append failing tests to `src/component/search.test.ts`**

Add a setup helper + tests (uses its own collection with filter/facet fields):

```ts
describe("filtering + faceting", () => {
  async function setupFacets() {
    const t = convexTest(schema, modules);
    await t.mutation(api.collections.createCollection, {
      name: "shop",
      searchFields: ["name"],
      storedFields: "all",
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
      ],
      facetFields: ["brand"],
    });
    await t.mutation(api.write.upsertMany, {
      collection: "shop",
      docs: [
        { id: "1", doc: { name: "running shoe", brand: "Aurora", price: 90 } },
        { id: "2", doc: { name: "trail shoe", brand: "Aurora", price: 110 } },
        { id: "3", doc: { name: "rain jacket", brand: "Nimbus", price: 150 } },
      ],
    });
    return t;
  }

  it("filterBy narrows the result set", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      filterBy: "brand:Aurora",
    });
    expect(r.found).toBe(2);
  });

  it("numeric comparator filter", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      filterBy: "price:>100",
    });
    expect(r.found).toBe(2); // 110, 150
  });

  it("filter combines with a text query (intersection)", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "shoe",
      filterBy: "brand:Aurora",
    });
    expect(r.found).toBe(2); // both shoes are Aurora
  });

  it("facet_counts reflect the filtered+searched set, sorted by count desc", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      facetBy: ["brand"],
    });
    expect(r.facet_counts).toEqual([
      {
        field_name: "brand",
        counts: [
          { value: "Aurora", count: 2 },
          { value: "Nimbus", count: 1 },
        ],
      },
    ]);
  });

  it("maxFacetValues caps the number of values", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      facetBy: ["brand"],
      maxFacetValues: 1,
    });
    expect(r.facet_counts[0].counts).toEqual([{ value: "Aurora", count: 2 }]);
  });

  it("facet over a filtered set is query-scoped", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      filterBy: "price:>100",
      facetBy: ["brand"],
    });
    expect(r.facet_counts[0].counts).toEqual([
      { value: "Aurora", count: 1 },
      { value: "Nimbus", count: 1 },
    ]);
  });

  it("absent facetBy yields empty facet_counts", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "" });
    expect(r.facet_counts).toEqual([]);
  });

  it("throws on a facet field not declared", async () => {
    const t = await setupFacets();
    await expect(
      t.query(api.search.search, { collection: "shop", q: "", facetBy: ["price"] }),
    ).rejects.toThrow(/facet/i);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/search.test.ts`
Expected: FAIL — filterBy/facetBy not handled.

- [ ] **Step 3: Replace the ENTIRE `src/component/search.ts` with:**

```ts
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import { candidateTermsForToken } from "./matching";
import { parseFilter } from "./filter";
import type { SearchResult, Hit, FacetCount } from "./types";

const MAX_PER_PAGE = 250;

// For one token's candidate terms, return docId -> best score among matched terms,
// restricted to queryBy fields when provided.
async function docScoresForToken(
  ctx: QueryCtx,
  collection: string,
  candidates: Map<string, number>,
  queryBy: string[] | undefined,
): Promise<Map<string, number>> {
  const docScore = new Map<string, number>();
  for (const [term, score] of candidates) {
    const rows = await ctx.db
      .query("postings")
      .withIndex("by_collection_term", (q) =>
        q.eq("collection", collection).eq("term", term),
      )
      .collect();
    for (const r of rows) {
      if (queryBy && !queryBy.includes(r.field)) continue;
      const cur = docScore.get(r.docId);
      if (cur === undefined || score > cur) docScore.set(r.docId, score);
    }
  }
  return docScore;
}

export const search = query({
  args: {
    collection: v.string(),
    q: v.string(),
    page: v.optional(v.number()),
    perPage: v.optional(v.number()),
    queryBy: v.optional(v.array(v.string())),
    filterBy: v.optional(v.string()),
    facetBy: v.optional(v.array(v.string())),
    maxFacetValues: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchResult> => {
    const start = Date.now();
    const collection = await requireCollection(ctx, args.collection);

    const page = Math.max(1, Math.floor(args.page ?? 1));
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(args.perPage ?? 10)));

    const allDocs = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) => q.eq("collection", args.collection))
      .collect();
    const out_of = allDocs.length;
    const byId = new Map(allDocs.map((d) => [d.docId, d.stored]));

    const tokens = tokenize(args.q);

    let matchedIds: string[];
    let scoreById: Map<string, number> | null = null;

    if (tokens.length === 0) {
      matchedIds = allDocs.map((d) => d.docId);
    } else {
      const perToken: Map<string, number>[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const candidates = await candidateTermsForToken(
          ctx,
          args.collection,
          tokens[i],
          i === tokens.length - 1,
        );
        perToken.push(
          await docScoresForToken(ctx, args.collection, candidates, args.queryBy),
        );
      }
      // AND across tokens: a doc must appear in every token's score map.
      perToken.sort((a, b) => a.size - b.size);
      const [first, ...rest] = perToken;
      scoreById = new Map();
      for (const [docId, s0] of first) {
        if (rest.every((m) => m.has(docId))) {
          let total = s0;
          for (const m of rest) total += m.get(docId)!;
          scoreById.set(docId, total);
        }
      }
      matchedIds = [...scoreById.keys()];
    }

    // Apply structured filter (in-memory over already-loaded stored docs).
    if (args.filterBy && args.filterBy.trim() !== "") {
      const fieldTypes: Record<string, "string" | "number"> = {};
      for (const f of collection.filterFields ?? []) fieldTypes[f.field] = f.type;
      const predicate = parseFilter(args.filterBy, fieldTypes);
      matchedIds = matchedIds.filter((id) =>
        predicate((byId.get(id) ?? {}) as Record<string, unknown>),
      );
    }

    const found = matchedIds.length;

    // Single source of order: score desc (tie docId asc) when scored, else docId asc.
    if (scoreById) {
      matchedIds.sort((a, b) => {
        const d = scoreById!.get(b)! - scoreById!.get(a)!;
        return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
      });
    } else {
      matchedIds.sort();
    }

    // Faceting over the full (filtered) result set — query-scoped counts.
    const facet_counts: FacetCount[] = [];
    if (args.facetBy && args.facetBy.length > 0) {
      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
      for (const field of args.facetBy) {
        if (!declared.has(field)) {
          throw new Error(`Field "${field}" is not a declared facet field`);
        }
        const tally = new Map<string, number>();
        for (const id of matchedIds) {
          const doc = byId.get(id) as Record<string, unknown> | undefined;
          const raw = doc?.[field];
          if (raw === undefined || raw === null) continue;
          const value = String(raw);
          tally.set(value, (tally.get(value) ?? 0) + 1);
        }
        const counts = [...tally.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .slice(0, maxValues)
          .map(([value, count]) => ({ value, count }));
        facet_counts.push({ field_name: field, counts });
      }
    }

    const pageIds = matchedIds.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
    const hits: Hit[] = pageIds.map((id) => ({
      document: (byId.get(id) ?? {}) as Record<string, unknown>,
      highlight: {},
      text_match: scoreById ? (scoreById.get(id) ?? 0) : 0,
    }));

    return {
      found,
      page,
      out_of,
      search_time_ms: Date.now() - start,
      hits,
      facet_counts,
    };
  },
});
```

- [ ] **Step 4: Regenerate + run the whole suite**

Run: `npm run build:codegen && npx vitest run`
Expected: PASS — all prior tests + the 8 new filter/facet tests. If a prior search test breaks due to ordering, confirm the single post-filter sort preserves score-desc/docId-asc (it does) and docId order for match-all.

- [ ] **Step 5: Commit**

```bash
git add src/component/search.ts src/component/search.test.ts src/component/_generated
git commit -m "feat: filter_by + query-scoped facet_counts in search"
```

---

## Task 4: Client passthrough

**Files:** Modify `src/client/index.ts`.

- [ ] **Step 1: Extend the client `search` and `createCollection` signatures**

In `src/client/index.ts`, update `createCollection` args type to include the new optional fields and pass them through:

```ts
  async createCollection(
    ctx: MutationCtx,
    args: {
      name: string;
      searchFields: string[];
      storedFields?: "all" | string[];
      filterFields?: { field: string; type: "string" | "number" }[];
      facetFields?: string[];
    },
  ) {
    return ctx.runMutation(this.component.collections.createCollection, args);
  }
```

Update `search` args type + passthrough:

```ts
  async search(
    ctx: QueryCtx,
    args: {
      collection: string;
      q: string;
      page?: number;
      perPage?: number;
      queryBy?: string[];
      filterBy?: string;
      facetBy?: string[];
      maxFacetValues?: number;
    },
  ): Promise<SearchResult> {
    return ctx.runQuery(this.component.search.search, args);
  }
```

- [ ] **Step 2: Verify build + typecheck**

Run: `npm run build && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/client/index.ts
git commit -m "feat: client passthrough for filterBy/facetBy/createCollection config"
```

---

## Task 5: Example — declare fields, active facet sidebar, verify

**Files:** Modify `example/convex/products.ts`, `example/src/Storefront.tsx`, `example/src/components/FacetSidebar.tsx`.

- [ ] **Step 1: Declare filter/facet fields + passthrough in `example/convex/products.ts`**

Replace the `seed` mutation so it RESETS the collection (delete-if-exists, then create with the new filter/facet config, then re-upsert) — the old `if (!existing)` guard would otherwise skip the config change:
```ts
export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await search.getCollection(ctx, COLLECTION);
    if (existing) await search.deleteCollection(ctx, COLLECTION);
    await search.createCollection(ctx, {
      name: COLLECTION,
      searchFields: ["name", "description", "brand", "category"],
      storedFields: "all",
      filterFields: [
        { field: "brand", type: "string" },
        { field: "category", type: "string" },
        { field: "price", type: "number" },
      ],
      facetFields: ["brand", "category"],
    });
    await search.upsertMany(ctx, {
      collection: COLLECTION,
      docs: SAMPLE.map(({ id, ...rest }) => ({ id, doc: { id, ...rest } })),
    });
    return { seeded: SAMPLE.length };
  },
});
```
And change `searchProducts` to accept + pass filter/facet args:
```ts
export const searchProducts = query({
  args: {
    q: v.string(),
    page: v.optional(v.number()),
    perPage: v.optional(v.number()),
    filterBy: v.optional(v.string()),
    facetBy: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) =>
    search.search(ctx, { collection: COLLECTION, ...args }),
});
```

- [ ] **Step 2: Make `example/src/components/FacetSidebar.tsx` active**

```tsx
type FacetCount = { field_name: string; counts: { value: string; count: number }[] };

export function FacetSidebar({
  facets,
  selected,
  onToggle,
}: {
  facets: FacetCount[];
  selected: Record<string, string[]>;
  onToggle: (field: string, value: string) => void;
}) {
  return (
    <aside style={{ width: 220 }}>
      <h3>Filters</h3>
      {facets.map((f) => (
        <div key={f.field_name} style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, textTransform: "capitalize" }}>{f.field_name}</div>
          {f.counts.map((c) => (
            <label key={c.value} style={{ display: "block", fontSize: 14 }}>
              <input
                type="checkbox"
                checked={(selected[f.field_name] ?? []).includes(c.value)}
                onChange={() => onToggle(f.field_name, c.value)}
              />{" "}
              {c.value} <span style={{ color: "#888" }}>({c.count})</span>
            </label>
          ))}
        </div>
      ))}
      <h3>Sort</h3>
      <select disabled>
        <option>Relevance</option>
      </select>
    </aside>
  );
}
```

- [ ] **Step 3: Wire selection → filterBy in `example/src/Storefront.tsx`**

Replace `Storefront.tsx` with:
```tsx
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { SearchBar } from "./components/SearchBar";
import { ProductGrid } from "./components/ProductGrid";
import { FacetSidebar } from "./components/FacetSidebar";

const PER_PAGE = 4;

// Build a Typesense-style filter_by string from selected facet values.
function buildFilterBy(selected: Record<string, string[]>): string | undefined {
  const clauses: string[] = [];
  for (const [field, values] of Object.entries(selected)) {
    if (values.length === 0) continue;
    clauses.push(values.length === 1 ? `${field}:${values[0]}` : `${field}:[${values.join(",")}]`);
  }
  return clauses.length ? clauses.join(" && ") : undefined;
}

export function Storefront() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const seed = useMutation(api.products.seed);

  const filterBy = buildFilterBy(selected);
  const result = useQuery(api.products.searchProducts, {
    q,
    page,
    perPage: PER_PAGE,
    filterBy,
    facetBy: ["brand", "category"],
  });

  const totalPages = result ? Math.max(1, Math.ceil(result.found / PER_PAGE)) : 1;

  const onToggle = (field: string, value: string) => {
    setPage(1);
    setSelected((prev) => {
      const cur = prev[field] ?? [];
      const nextVals = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
      return { ...prev, [field]: nextVals };
    });
  };

  return (
    <div style={{ display: "flex", gap: 24, padding: 24, fontFamily: "system-ui" }}>
      <FacetSidebar facets={result?.facet_counts ?? []} selected={selected} onToggle={onToggle} />
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <SearchBar value={q} onChange={(v) => { setQ(v); setPage(1); }} />
          <button onClick={() => seed()}>Seed data</button>
        </div>
        <p>{result ? `${result.found} results` : "Loading…"}</p>
        <ProductGrid hits={result?.hits ?? []} />
        <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span>Page {page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Deploy, re-seed (now resets cleanly), verify on the deployment**

The new `seed` deletes + recreates the collection, so it picks up the filter/facet config. Run from repo root:
```bash
npm run build:codegen
npx convex dev --once        # if a `convex dev` watcher already holds the deployment, skip this — build:codegen pushed already
npx convex run products:seed # { seeded: 6 }
```
Then verify (report actual output):
```bash
npx convex run products:searchProducts '{"q":"","facetBy":["brand","category"]}'   # facet_counts: brand Aurora 2 / Nimbus 2 / Vertex 2; category counts too
npx convex run products:searchProducts '{"q":"","filterBy":"brand:Aurora"}'         # found 2
npx convex run products:searchProducts '{"q":"","filterBy":"price:>100","facetBy":["brand"]}'  # found 3 (109,149,?) facets scoped
```
Confirm `facet_counts` are populated and `filterBy` narrows `found`. If a result is clearly wrong, STOP and report (don't patch blindly). Then confirm the frontend compiles:
```bash
npm run typecheck
cd example && npx vite build
```
Expected: typecheck clean; vite build succeeds. (The unit suite from Task 3 is the authoritative correctness proof; these live checks confirm the wiring + UI build.)

- [ ] **Step 5: Commit**

```bash
cd /Users/newuser/convex_component
git add example
git commit -m "feat: active facet sidebar + filter/facet config in example"
```

---

## Task 6: README + final verification

**Files:** Modify `README.md`.

- [ ] **Step 1: Update `README.md`**

- Move filtering + faceting OUT of "Roadmap & limitations" INTO Features/behavior: document `filterFields`/`facetFields` config (must be within `storedFields`), the `filter_by` grammar (exact, in-set, comparators, range, `&&`/`||`/parens; negation not yet), `filterBy`/`facetBy`/`maxFacetValues` search args, and query-scoped `facet_counts` output (capped, count-desc).
- Keep remaining limits: no highlighting; arrays-as-facets and the indexed filters table are Phase 4; bounded-scale ceiling unchanged; negation deferred.
- Verify all claims against `filter.ts`, `collections.ts`, `search.ts`.

- [ ] **Step 2: Final verification**

Run:
```bash
npx vitest run
npm run build
npm run typecheck
```
Expected: all tests pass; no TS errors; typecheck clean.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document filtering + faceting"
```

---

## Self-Review notes (reconciled against the spec)

- **Spec coverage:** filterFields/facetFields config + storedFields validation ✔ (Task 2); pure `parseFilter` full-boolean grammar + error cases ✔ (Task 1); search `filterBy`/`facetBy`/`maxFacetValues` ✔ (Task 3); in-memory predicate over loaded `byId` ✔ (Task 3); query-scoped facet tally, cap, count-desc/value-asc ordering ✔ (Task 3); envelope `facet_counts` shape + `[]` when absent ✔ (Task 3); client passthrough ✔ (Task 4); example config + active sidebar ✔ (Task 5); README ✔ (Task 6).
- **Numeric vs string** comparison decided by declared `type` ✔ (filter.ts); missing/non-coercible stored value → clause false (never throws at eval) ✔.
- **No write-path/new-table change** ✔ — schema change is only two optional columns on `collections`.
- **Type/name consistency:** `parseFilter(input, fieldTypes)` and `Predicate`/`FieldType` exports used identically in Tasks 1 & 3; `FacetCount` (existing in types.ts) reused; `requireCollection` now captured as `collection` to read `filterFields`/`facetFields`.
- **Ordering regression guard:** Task 3 consolidates sorting into ONE post-filter sort (score-desc/docId-asc when scored, docId-asc for match-all); prior search tests assert counts or sorted names, so they remain green. Task 3 Step 3 explicitly calls out removing the now-duplicated `byId`/`.sort()` lines.
