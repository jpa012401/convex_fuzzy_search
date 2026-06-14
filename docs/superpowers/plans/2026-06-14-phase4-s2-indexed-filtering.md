# Phase 4 · S2 — Indexed Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve `filter_by` to a docId set through a write-maintained `filters` index so filtered queries never load the whole collection.

**Architecture:** A `filters` table (`by_str`/`by_num`/`by_doc`) is maintained in the write path for declared `filterFields`. `filter.ts` is refactored to parse into an AST with two interpreters: `astToPredicate` (in-memory, kept for back-compat) and `resolveAstToDocIds` (walks the AST against the indexes). `search` resolves the filter to a docId set and intersects with the candidate set on every path.

**Tech Stack:** Convex component, TypeScript (`verbatimModuleSyntax` ON), convex-test + Vitest.

**Spec:** `docs/superpowers/specs/2026-06-14-phase4-s2-indexed-filtering-design.md`

**Repo conventions:** colocated tests; tests that hit the write path/search must `registerAggregate(t, "docCount")` (from `@convex-dev/aggregate/test`) after `convexTest(...)` (S1 added the nested aggregate). After schema changes run `npm run build:codegen`. `import type` for types.

---

## Task 1: `filters` table schema

**Files:** Modify `src/component/schema.ts`.

- [ ] **Step 1: Add the table** inside the existing `defineSchema({ ... })` (alongside the others):

```ts
  filters: defineTable({
    collection: v.string(),
    field: v.string(),
    docId: v.string(),
    strVal: v.optional(v.string()),
    numVal: v.optional(v.number()),
  })
    .index("by_str", ["collection", "field", "strVal"])
    .index("by_num", ["collection", "field", "numVal"])
    .index("by_doc", ["collection", "docId"]),
```

- [ ] **Step 2: Regenerate + verify**

Run: `npm run build:codegen`
Expected: builds; `_generated` knows `filters`.

- [ ] **Step 3: Commit**

```bash
git add src/component/schema.ts src/component/_generated
git commit -m "feat: add filters index table"
```

---

## Task 2: `filter.ts` — AST + predicate + index resolver

**Files:** Modify `src/component/filter.ts`; Test `src/component/filter.test.ts` (unchanged behavior) + new `src/component/filter-resolve.test.ts`.

- [ ] **Step 1: Write failing resolver test `src/component/filter-resolve.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { parseFilterAst, resolveAstToDocIds } from "./filter";

const modules = import.meta.glob("./**/*.ts");
const types = { brand: "string", price: "number" } as const;

// Insert filter rows directly (independent of the write path) for a fixture.
async function seedFilters(t: any) {
  await t.run(async (ctx: any) => {
    const rows = [
      { docId: "a", brand: "Aurora", price: 90 },
      { docId: "b", brand: "Aurora", price: 110 },
      { docId: "c", brand: "Nimbus", price: 150 },
    ];
    for (const r of rows) {
      await ctx.db.insert("filters", { collection: "shop", field: "brand", docId: r.docId, strVal: r.brand });
      await ctx.db.insert("filters", { collection: "shop", field: "price", docId: r.docId, numVal: r.price });
    }
  });
}
const resolve = (t: any, expr: string) =>
  t.run((ctx: any) => resolveAstToDocIds(ctx, "shop", parseFilterAst(expr, types)));
const sorted = (s: Set<string>) => [...s].sort();

describe("resolveAstToDocIds", () => {
  it("exact, in-set, comparator, range, AND, OR", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await seedFilters(t);
    expect(sorted(await resolve(t, "brand:Aurora"))).toEqual(["a", "b"]);
    expect(sorted(await resolve(t, "brand:[Aurora,Nimbus]"))).toEqual(["a", "b", "c"]);
    expect(sorted(await resolve(t, "price:>100"))).toEqual(["b", "c"]);
    expect(sorted(await resolve(t, "price:[100..200]"))).toEqual(["b", "c"]);
    expect(sorted(await resolve(t, "brand:Aurora && price:>100"))).toEqual(["b"]);
    expect(sorted(await resolve(t, "brand:Nimbus || price:<100"))).toEqual(["a", "c"]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/filter-resolve.test.ts`
Expected: FAIL — `parseFilterAst`/`resolveAstToDocIds` not exported.

- [ ] **Step 3: Rewrite `src/component/filter.ts`** to parse to an AST and add both interpreters (keep `tokenize` as-is; keep `parseFilter` working via the new pieces):

```ts
import type { QueryCtx } from "./_generated/server";

export type Predicate = (stored: Record<string, unknown>) => boolean;
export type FieldType = "string" | "number";

export type Ast =
  | { kind: "and"; left: Ast; right: Ast }
  | { kind: "or"; left: Ast; right: Ast }
  | { kind: "exact"; field: string; type: FieldType; value: string }
  | { kind: "inSet"; field: string; type: FieldType; values: string[] }
  | { kind: "cmp"; field: string; op: ">" | ">=" | "<" | "<="; num: number }
  | { kind: "range"; field: string; lo: number; hi: number };

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

export function parseFilterAst(
  input: string,
  fieldTypes: Record<string, FieldType>,
): Ast {
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

  function parseExpr(): Ast {
    let left = parseAnd();
    while (peek() && peek().t === "||") {
      next();
      left = { kind: "or", left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd(): Ast {
    let left = parseUnary();
    while (peek() && peek().t === "&&") {
      next();
      left = { kind: "and", left, right: parseUnary() };
    }
    return left;
  }
  function parseUnary(): Ast {
    if (peek() && peek().t === "(") {
      next();
      const e = parseExpr();
      expect(")");
      return e;
    }
    return parseClause();
  }
  function parseClause(): Ast {
    const f = next();
    if (!f || f.t !== "val") throw new Error("Expected a field name in filter");
    const field = f.v!;
    const type = fieldTypes[field];
    if (!type) throw new Error(`Unknown filter field: ${field}`);
    expect(":");
    return parseMatcher(field, type);
  }
  function parseMatcher(field: string, type: FieldType): Ast {
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
        return { kind: "range", field, lo, hi };
      }
      const values = [first];
      while (peek() && peek().t === ",") { next(); values.push(getVal()); }
      expect("]");
      if (type === "number") {
        for (const x of values) {
          if (Number.isNaN(Number(x))) throw new Error(`Invalid number in filter for ${field}: ${x}`);
        }
      }
      return { kind: "inSet", field, type, values };
    }
    if (p && (p.t === ">" || p.t === ">=" || p.t === "<" || p.t === "<=")) {
      const op = next().t as ">" | ">=" | "<" | "<=";
      if (type !== "number") throw new Error(`Comparator filter requires a numeric field: ${field}`);
      const num = Number(getVal());
      if (Number.isNaN(num)) throw new Error(`Invalid number in filter for ${field}`);
      return { kind: "cmp", field, op, num };
    }
    const val = getVal();
    if (type === "number" && Number.isNaN(Number(val))) {
      throw new Error(`Invalid number in filter for ${field}: ${val}`);
    }
    return { kind: "exact", field, type, value: val };
  }

  const ast = parseExpr();
  if (pos !== toks.length) throw new Error("Unexpected trailing tokens in filter");
  return ast;
}

// In-memory interpreter (unchanged semantics; missing/non-coercible -> false).
export function astToPredicate(ast: Ast): Predicate {
  switch (ast.kind) {
    case "and": {
      const l = astToPredicate(ast.left), r = astToPredicate(ast.right);
      return (d) => l(d) && r(d);
    }
    case "or": {
      const l = astToPredicate(ast.left), r = astToPredicate(ast.right);
      return (d) => l(d) || r(d);
    }
    case "exact": {
      if (ast.type === "number") {
        const n = Number(ast.value);
        return (d) => { const v = Number(d[ast.field]); return !Number.isNaN(v) && v === n; };
      }
      return (d) => d[ast.field] !== undefined && String(d[ast.field]) === ast.value;
    }
    case "inSet": {
      if (ast.type === "number") {
        const nums = ast.values.map((x) => Number(x));
        return (d) => { const v = Number(d[ast.field]); return !Number.isNaN(v) && nums.includes(v); };
      }
      return (d) => d[ast.field] !== undefined && ast.values.includes(String(d[ast.field]));
    }
    case "cmp": {
      const { field, op, num } = ast;
      return (d) => {
        const v = Number(d[field]);
        if (Number.isNaN(v)) return false;
        return op === ">" ? v > num : op === ">=" ? v >= num : op === "<" ? v < num : v <= num;
      };
    }
    case "range": {
      const { field, lo, hi } = ast;
      return (d) => { const v = Number(d[field]); return !Number.isNaN(v) && v >= lo && v <= hi; };
    }
  }
}

export function parseFilter(input: string, fieldTypes: Record<string, FieldType>): Predicate {
  return astToPredicate(parseFilterAst(input, fieldTypes));
}

// --- index resolver -------------------------------------------------------
async function strIds(ctx: QueryCtx, collection: string, field: string, value: string): Promise<string[]> {
  const rows = await ctx.db
    .query("filters")
    .withIndex("by_str", (q) => q.eq("collection", collection).eq("field", field).eq("strVal", value))
    .collect();
  return rows.map((r) => r.docId);
}
async function numEqIds(ctx: QueryCtx, collection: string, field: string, num: number): Promise<string[]> {
  const rows = await ctx.db
    .query("filters")
    .withIndex("by_num", (q) => q.eq("collection", collection).eq("field", field).eq("numVal", num))
    .collect();
  return rows.map((r) => r.docId);
}
async function numCmpIds(ctx: QueryCtx, collection: string, field: string, op: string, num: number): Promise<string[]> {
  const rows = await ctx.db
    .query("filters")
    .withIndex("by_num", (q) => {
      const b = q.eq("collection", collection).eq("field", field);
      return op === ">" ? b.gt("numVal", num)
        : op === ">=" ? b.gte("numVal", num)
        : op === "<" ? b.lt("numVal", num)
        : b.lte("numVal", num);
    })
    .collect();
  return rows.map((r) => r.docId);
}
async function numRangeIds(ctx: QueryCtx, collection: string, field: string, lo: number, hi: number): Promise<string[]> {
  const rows = await ctx.db
    .query("filters")
    .withIndex("by_num", (q) => q.eq("collection", collection).eq("field", field).gte("numVal", lo).lte("numVal", hi))
    .collect();
  return rows.map((r) => r.docId);
}

export async function resolveAstToDocIds(
  ctx: QueryCtx,
  collection: string,
  ast: Ast,
): Promise<Set<string>> {
  switch (ast.kind) {
    case "and": {
      const a = await resolveAstToDocIds(ctx, collection, ast.left);
      const b = await resolveAstToDocIds(ctx, collection, ast.right);
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      const out = new Set<string>();
      for (const id of small) if (big.has(id)) out.add(id);
      return out;
    }
    case "or": {
      const a = await resolveAstToDocIds(ctx, collection, ast.left);
      const b = await resolveAstToDocIds(ctx, collection, ast.right);
      for (const id of b) a.add(id);
      return a;
    }
    case "exact":
      return new Set(ast.type === "number"
        ? await numEqIds(ctx, collection, ast.field, Number(ast.value))
        : await strIds(ctx, collection, ast.field, ast.value));
    case "inSet": {
      const out = new Set<string>();
      for (const v of ast.values) {
        const ids = ast.type === "number"
          ? await numEqIds(ctx, collection, ast.field, Number(v))
          : await strIds(ctx, collection, ast.field, v);
        for (const id of ids) out.add(id);
      }
      return out;
    }
    case "cmp":
      return new Set(await numCmpIds(ctx, collection, ast.field, ast.op, ast.num));
    case "range":
      return new Set(await numRangeIds(ctx, collection, ast.field, ast.lo, ast.hi));
  }
}
```

- [ ] **Step 4: Run both filter tests**

Run: `npm run build:codegen && npx vitest run src/component/filter.test.ts src/component/filter-resolve.test.ts`
Expected: PASS — `filter.test.ts` unchanged behavior via the back-compat `parseFilter`; resolver test passes.

- [ ] **Step 5: Commit**

```bash
git add src/component/filter.ts src/component/filter-resolve.test.ts src/component/_generated
git commit -m "feat: filter AST + index resolver (resolveAstToDocIds)"
```

---

## Task 3: Maintain filter rows in the write path

**Files:** Modify `src/component/write.ts`, `src/component/collections.ts`; Test `src/component/filters-write.test.ts`.

- [ ] **Step 1: Write failing test `src/component/filters-write.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
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
  return t;
}
const filterRows = (t: any, docId: string) =>
  t.run((ctx: any) =>
    ctx.db.query("filters").withIndex("by_doc", (q: any) => q.eq("collection", "shop").eq("docId", docId)).collect(),
  );

describe("write path maintains filter rows", () => {
  it("writes string/number rows; skips missing/non-coercible; replaces; deletes", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "shoe", brand: "Aurora", price: 90 } });
    let rows = await filterRows(t, "p1");
    expect(rows.map((r: any) => `${r.field}:${r.strVal ?? r.numVal}`).sort()).toEqual(["brand:Aurora", "price:90"]);

    // missing brand, non-numeric price -> no rows
    await t.mutation(api.write.upsert, { collection: "shop", id: "p2", doc: { name: "x", price: "NaNish" } });
    expect(await filterRows(t, "p2")).toEqual([]);

    // re-upsert replaces (no orphans)
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "shoe", brand: "Nimbus", price: 95 } });
    rows = await filterRows(t, "p1");
    expect(rows.map((r: any) => `${r.field}:${r.strVal ?? r.numVal}`).sort()).toEqual(["brand:Nimbus", "price:95"]);

    // delete clears
    await t.mutation(api.write.delete, { collection: "shop", id: "p1" });
    expect(await filterRows(t, "p1")).toEqual([]);
  });

  it("deleteCollection clears filter rows", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "shop", id: "p1", doc: { name: "x", brand: "Aurora", price: 1 } });
    await t.mutation(api.collections.deleteCollection, { name: "shop" });
    expect(await filterRows(t, "p1")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/filters-write.test.ts`
Expected: FAIL — no filter rows written.

- [ ] **Step 3: Write filter rows in `src/component/write.ts`**

In `clearDoc`, after deleting postings and before/after the document delete, also delete the doc's filter rows:
```ts
  const filt = await ctx.db
    .query("filters")
    .withIndex("by_doc", (q) => q.eq("collection", collection).eq("docId", docId))
    .collect();
  for (const r of filt) await ctx.db.delete(r._id);
```

In `upsertInternal`, after inserting the `documents` row (and before/after `applyTermDiff`), insert filter rows for declared filter fields:
```ts
  for (const f of col.filterFields ?? []) {
    const value = doc[f.field];
    if (value === undefined || value === null) continue;
    if (f.type === "string") {
      await ctx.db.insert("filters", { collection, field: f.field, docId: id, strVal: String(value) });
    } else {
      const num = Number(value);
      if (!Number.isNaN(num)) {
        await ctx.db.insert("filters", { collection, field: f.field, docId: id, numVal: num });
      }
    }
  }
```
(`col` is the collection row from `requireCollection`, which carries `filterFields`.)

- [ ] **Step 4: Clear filters in `deleteCollection` (`src/component/collections.ts`)**

In the `deleteCollection` handler, add a cleanup for the `filters` table (keyed `[collection, docId]` via `by_doc`, queried by the collection prefix). Add alongside the existing cleanup loops, before `clearCollectionCount`/`ctx.db.delete(c._id)`:
```ts
    const filterRows = await ctx.db
      .query("filters")
      .withIndex("by_doc", (q) => q.eq("collection", args.name))
      .collect();
    for (const r of filterRows) await ctx.db.delete(r._id);
```

- [ ] **Step 5: Regenerate + run (new test + existing write/collection tests)**

Run: `npm run build:codegen && npx vitest run src/component/filters-write.test.ts src/component/write.test.ts src/component/collections.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/component/write.ts src/component/collections.ts src/component/filters-write.test.ts src/component/_generated
git commit -m "feat: maintain filter index rows in the write path"
```

---

## Task 4: Resolve filters in `search.ts`

**Files:** Modify `src/component/search.ts`; Test `src/component/search.test.ts` (append).

- [ ] **Step 1: Append failing tests to `src/component/search.test.ts`** (file already registers the aggregate in `setupFacets`):

```ts
describe("S2 indexed filtering", () => {
  it("browse + filter returns the indexed set (no full-load dependency)", async () => {
    const t = await setupFacets(); // shop: 3 docs, brand Aurora/Aurora/Nimbus, price 90/110/150
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "brand:Aurora" });
    expect(r.found).toBe(2);
    expect(r.hits.map((h: any) => h.document.name).sort()).toEqual(["running shoe", "trail shoe"]);
  });

  it("numeric range filter via index", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "price:[100..200]" });
    expect(r.found).toBe(2);
  });

  it("text + filter intersect via index", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "shoe", filterBy: "brand:Aurora" });
    expect(r.found).toBe(2);
  });

  it("filter + facet still query-scoped", async () => {
    const t = await setupFacets();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "price:>100", facetBy: ["brand"] });
    expect(r.facet_counts[0].counts).toEqual([
      { value: "Aurora", count: 1 },
      { value: "Nimbus", count: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run, verify PASS-or-FAIL baseline**

Run: `npx vitest run src/component/search.test.ts`
Expected: these pass against the current in-memory filter too (behavior-preserving). Confirm the suite is green before changing search, then make the change and keep it green (the win is index resolution, not a result change).

- [ ] **Step 3: Update `src/component/search.ts`** — replace the filter handling to use the resolver.

Change the import:
```ts
import { parseFilterAst, resolveAstToDocIds } from "./filter";
```
(remove the old `parseFilter` import.)

Restructure the handler body AFTER the lean-browse early return. Resolve the filter once, then branch:

```ts
    // Resolve filter to a docId set via the index (S2), if present.
    let filterIds: Set<string> | null = null;
    if (hasFilter) {
      const fieldTypes: Record<string, "string" | "number"> = {};
      for (const f of collection.filterFields ?? []) fieldTypes[f.field] = f.type;
      filterIds = await resolveAstToDocIds(ctx, args.collection, parseFilterAst(args.filterBy as string, fieldTypes));
    }

    let matchedIds: string[];
    let scoreById: Map<string, number> | null = null;
    const matchedTerms = new Set<string>();
    let byId: Map<string, unknown>;

    if (tokens.length > 0) {
      // TEXT PATH (unchanged candidate computation) ...
      // [keep the existing perToken/scoreById block that produces matchedIds = [...scoreById.keys()]]
      // then intersect with the filter set:
      if (filterIds) matchedIds = matchedIds.filter((id) => filterIds!.has(id));
      byId = await loadDocs(ctx, args.collection, matchedIds);
    } else if (filterIds) {
      // BROWSE + FILTER: the filter set is the result set (no full-collection load).
      matchedIds = [...filterIds];
      byId = await loadDocs(ctx, args.collection, matchedIds);
    } else {
      // BROWSE + facets/custom-order but NO filter: still full load (S3/S4 replace this).
      const allDocs = await ctx.db
        .query("documents")
        .withIndex("by_collection_doc", (q) => q.eq("collection", args.collection))
        .collect();
      byId = new Map(allDocs.map((d) => [d.docId, d.stored]));
      matchedIds = allDocs.map((d) => d.docId);
    }
```

REMOVE the old in-memory filter block (`if (hasFilter) { ... parseFilter ... matchedIds.filter(predicate) }`) — filtering is now done via `filterIds` above. Keep `found`, sort, facet, pagination, hits exactly as they are after this point.

Provide the FULL updated file in the commit; ensure `storedOf`, `found = matchedIds.length`, ranking, faceting, hydration are unchanged and operate on the new `matchedIds`/`byId`.

- [ ] **Step 4: Regenerate + run the WHOLE suite**

Run: `npm run build:codegen && npx vitest run`
Expected: ALL pass — every existing filter/facet/text test plus the 4 new S2 tests. If a prior test breaks, STOP and report (results must be identical; only the read path changed).

- [ ] **Step 5: Commit**

```bash
git add src/component/search.ts src/component/search.test.ts src/component/_generated
git commit -m "feat: resolve filter_by via the index in search (no full load for filtered queries)"
```

---

## Task 5: Filter backfill + 5k verify + docs

**Files:** Modify `src/component/backfill.ts`, `src/client/index.ts`, `example/convex/products.ts`, `README.md`.

- [ ] **Step 1: Add a filter-row backfill to `src/component/backfill.ts`**

Mirror the existing `backfillCounterPage` manual cursor paging (do NOT use `ctx.db.query().paginate()` — it throws inside a component). Re-derive filter rows from `stored` using the collection's `filterFields`, idempotently (clear the doc's filter rows then re-insert):

```ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireCollection } from "./collections";

export const backfillFiltersPage = mutation({
  args: { collection: v.string(), cursor: v.optional(v.union(v.string(), v.null())), batch: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const col = await requireCollection(ctx, args.collection);
    const batch = args.batch ?? 200;
    const cursor = args.cursor ?? null;
    const page = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) =>
        cursor === null
          ? q.eq("collection", args.collection)
          : q.eq("collection", args.collection).gt("docId", cursor),
      )
      .take(batch + 1);
    const rows = page.slice(0, batch);
    for (const d of rows) {
      const existing = await ctx.db
        .query("filters")
        .withIndex("by_doc", (q) => q.eq("collection", args.collection).eq("docId", d.docId))
        .collect();
      for (const r of existing) await ctx.db.delete(r._id);
      const stored = d.stored as Record<string, unknown>;
      for (const f of col.filterFields ?? []) {
        const value = stored[f.field];
        if (value === undefined || value === null) continue;
        if (f.type === "string") {
          await ctx.db.insert("filters", { collection: args.collection, field: f.field, docId: d.docId, strVal: String(value) });
        } else {
          const num = Number(value);
          if (!Number.isNaN(num)) {
            await ctx.db.insert("filters", { collection: args.collection, field: f.field, docId: d.docId, numVal: num });
          }
        }
      }
    }
    const done = page.length <= batch;
    return { cursor: done ? null : rows[rows.length - 1].docId, done };
  },
});
```
(Keep the existing `backfillCounterPage` as-is in this file.)

- [ ] **Step 2: Test it** — append to `src/component/filters-write.test.ts`:

```ts
it("backfill rebuilds filter rows for pre-existing docs", async () => {
  const t = await setup();
  // insert a documents row directly, bypassing the write path (no filter rows)
  await t.run(async (ctx) => {
    await ctx.db.insert("documents", { collection: "shop", docId: "z", stored: { name: "z", brand: "Aurora", price: 5 } });
  });
  expect(await filterRows(t, "z")).toEqual([]);
  let cursor: string | null = null;
  do {
    const r: any = await t.mutation(api.backfill.backfillFiltersPage, { collection: "shop", cursor, batch: 1 });
    cursor = r.cursor;
  } while (cursor !== null);
  const rows = await filterRows(t, "z");
  expect(rows.map((r: any) => `${r.field}:${r.strVal ?? r.numVal}`).sort()).toEqual(["brand:Aurora", "price:5"]);
});
```
Run: `npm run build:codegen && npx vitest run src/component/filters-write.test.ts` → PASS.

- [ ] **Step 3: Client passthrough** — add to `src/client/index.ts` (next to `backfillCounterPage`):
```ts
  async backfillFiltersPage(
    ctx: MutationCtx,
    args: { collection: string; cursor?: string | null; batch?: number },
  ): Promise<{ cursor: string | null; done: boolean }> {
    return ctx.runMutation(this.component.backfill.backfillFiltersPage, args);
  }
```

- [ ] **Step 4: Example driver + live verify** — add a self-chaining `backfillFilters` mutation to `example/convex/products.ts` mirroring the existing `backfillCounter`, then run it and verify filtering at 5k:
```bash
npm run build:codegen
# re-seed so the write path writes filter rows (or run the backfill driver):
npx convex run products:startSeed '{"total":5000}'   # wait until out_of=5000
npx convex run products:searchProducts '{"q":"","filterBy":"category:Outdoors"}'  # found = #Outdoors, no full scan
npx convex run products:searchProducts '{"q":"","filterBy":"price:[100..200]","facetBy":["brand"]}'
```
Report actual `found` + that browse+filter no longer depends on collection size. (Re-seeding writes filter rows directly via the new write path; the `backfillFilters` driver is for pre-existing data.)

- [ ] **Step 5: README** — document S2: `filter_by` resolves via the `filters` index; filtered queries (browse+filter and text+filter) no longer load the whole collection; a `backfillFiltersPage` exists for pre-S2 data; remaining limits (negation, array fields, facet counts S3, sort indexes S4) kept.

- [ ] **Step 6: Final verification + commit**
```bash
npx vitest run && npm run build && npm run typecheck
git add src/component/backfill.ts src/client/index.ts example/convex/products.ts src/component/filters-write.test.ts README.md src/component/_generated
git commit -m "feat: filter-row backfill + client/example + docs; verify indexed filtering at 5k"
```

---

## Self-Review notes (reconciled against the spec)

- **Spec coverage:** filters table (by_str/by_num/by_doc) ✔ (Task 1); AST refactor with `parseFilterAst`/`astToPredicate`/`parseFilter` back-compat + `resolveAstToDocIds` ✔ (Task 2); write-path filter rows (string→strVal, number→numVal, skip missing/non-coercible, replace, delete, deleteCollection clear) ✔ (Task 3); search resolves filter to docId set, intersect on text path, filter-set-as-result on browse+filter, no full load for filtered queries ✔ (Task 4); backfill ✔ (Task 5).
- **Semantics preserved:** missing/non-coercible value → no filter row → excluded (matches predicate's `false`); numeric coercion identical; parse-time errors identical (the AST parser carries the same throws).
- **Type/name consistency:** `parseFilterAst`/`astToPredicate`/`parseFilter`/`resolveAstToDocIds` and `Ast` used consistently across filter.ts, filter-resolve.test, search.ts; `filters` columns/indexes consistent across schema, write.ts, collections.ts, filter.ts resolver, backfill.ts.
- **Deferrals (documented):** browse with facets/sort but no filter still full-loads (S3/S4); negation; array fields; facet counts; sort indexes.
- **Regression guard:** filter/facet/text results identical — search tests must stay green; only the read strategy changes.
