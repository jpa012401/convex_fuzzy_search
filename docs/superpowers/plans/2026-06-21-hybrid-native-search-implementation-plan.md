# Hybrid Native-Search Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the component's hand-rolled inverted index with Convex managed `.searchIndex` for text retrieval, keeping the ranking DSL / facet counts / sort / Typesense envelope on top — so search latency is flat with collection size.

**Architecture:** A single generic-slot `searchDocs` table (text0=all-fields + text1..8, filt0..7, numF0..3) backs nine native `.searchIndex`es; a runtime field→slot map bridges arbitrary tenant fields onto the static columns. Text retrieval is native (bounded `.take(K≤1024)`); AND is re-imposed app-side over the candidate window; the ranking DSL re-ranks; `found`/facets come from the `@convex-dev/aggregate` count + the bounded `facetCounts` table. See the spec: [2026-06-21-hybrid-native-search-spec.md](./2026-06-21-hybrid-native-search-spec.md).

**Tech Stack:** TypeScript, Convex component (`convex@1.41`), `@convex-dev/aggregate`, vitest + convex-test.

## Global Constraints

- **Branch:** `feat/hybrid-native-search`.
- **Slot pool (FINAL, baked into schema):** 8 search slots (`text0`=all searchFields space-joined + `text1..text8`), 8 string-filter slots (`filt0..filt7`), 4 numeric slots (`numF0..numF3`) → 9 search indexes `s0..s8`. One shared `FILTER_SLOTS` const spread into all nine so they can't drift.
- **Bounded-reads invariant (spec §6a):** NO function reads rows proportional to collection size. Search = `.take(K≤1024)` (native throws past 1024); `found` from the docCount aggregate (O(log n)); facet counts from the `facetCounts` TABLE bounded by `FACET_VALUE_READ_BUDGET=200` (field cardinality, not collection size); `deleteCollection`/reindex/`upsertMany` paged + `ctx.scheduler`-chained.
- **Public API + envelope frozen:** the client `FuzzySearch` methods and `searchResultValidator`/`hitValidator`/`facetCountValidator` do NOT change. (`statsResultValidator` MAY change — it is not part of the frozen envelope.)
- **Test convention (every vitest file):** `const modules = import.meta.glob("./**/*.ts")`; create with `convexTest(schema, modules)` then `registerAggregate(t, "docCount")` and `registerAggregate(t, "sortIndex")` before driving upsert/search. Native `.searchIndex` behavior is NOT simulated by convex-test — it is asserted only in the real-deployment smoke task.
- **Single shared types:** ONE `Candidate = { docId; stored; slotText; rankPos }`, ONE `synthScore(rankPos, total) = total<=0 ? 0 : (total-rankPos)/total`, defined once in `searchRead.ts`. Paging is 1-based everywhere (`pageStart = (page-1)*perPage`). `SLOT_LIMITS = { search: 8, strFilter: 8, numFilter: 4 }`.

---

## Task numbering note

14 logical tasks. Tasks 6 and 7 are the read-core pair (helpers; filter/rank resolvers). The deletion task (formerly "Task 13") is split: legacy-reference pruning is folded into Task 8's search.ts rewrite; the orphan-module/table deletion + `stats.ts`/`statsResultValidator` cleanup is its own task before the parity gate.

---

### Task 1: Generic-slot `searchDocs` table + 9 native search indexes; `slotMap` field on `collections`

Replace the hand-rolled inverted-index tables with a single generic-slot `searchDocs` table carrying the FINAL slot pool (`text0..text8`, `filt0..filt7`, `numF0..numF3`) and nine `.searchIndex`es (`s0..s8`), each exposing the SAME shared `FILTER_SLOTS` filterFields const (F10). Add the optional `slotMap` field to the `collections` table and a reusable `slotMapValidator`. This task only changes `schema.ts`; no module reads/writes the new table yet, so the gate is a schema-compile + existing-suite-still-green check.

**Files:**
- Modify: `/Users/newuser/convex_component/src/component/schema.ts`
- Test: `/Users/newuser/convex_component/src/component/schema-slots.test.ts` (Create)

**Interfaces:**
- Consumes from earlier tasks: none (first task).
- Produces for later tasks:
  - `searchDocs` table (defined in `schema.ts`) with columns `collection: string`, `docId: string`, `text0..text8?: string`, `filt0..filt7?: string`, `numF0..numF3?: number`, `stored: any`; index `by_collection_doc` on `["collection","docId"]`; search indexes `s0..s8` where `sN.searchField = "textN"` and `sN.filterFields = FILTER_SLOTS`.
  - `export const FILTER_SLOTS = ["collection","filt0","filt1","filt2","filt3","filt4","filt5","filt6","filt7","numF0","numF1","numF2","numF3"] as const;` — the single shared filterFields array (F10), spread into all nine `.searchIndex` calls.
  - `export const slotMapValidator` — `v.object({ search: v.record(v.string(), v.string()), strFilter: v.record(v.string(), v.string()), numFilter: v.record(v.string(), v.string()) })`.
  - `collections` table gains `slotMap: v.optional(slotMapValidator)`.
  - `collectionDocValidator` gains `slotMap: v.optional(slotMapValidator)` (so `getCollection` returns it).

Steps:

- [ ] **Step 1:** Write the failing test asserting the new schema shape exists and is registrable. Create `/Users/newuser/convex_component/src/component/schema-slots.test.ts`:
```ts
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
      "numF0", "numF1", "numF2", "numF3",
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
```

- [ ] **Step 2:** Run the test and confirm it FAILS (no `FILTER_SLOTS`/`slotMapValidator`/`searchDocs` yet):
```
npx vitest run src/component/schema-slots.test.ts
```
Expected: FAIL — TypeScript/import error `FILTER_SLOTS is not exported` or `tables.searchDocs is undefined`.

- [ ] **Step 3:** In `/Users/newuser/convex_component/src/component/schema.ts`, add the shared filter-slot const and the slot-map validator above `export default defineSchema(`. Insert immediately after the `facetCountValidator` definition (line 88 region):
```ts
// The single shared filterFields array spread into every searchDocs search
// index so the nine indexes cannot drift. collection is always present so a
// search is .eq("collection", name)-scoped (multi-tenant on one table).
export const FILTER_SLOTS = [
  "collection",
  "filt0", "filt1", "filt2", "filt3", "filt4", "filt5", "filt6", "filt7",
  "numF0", "numF1", "numF2", "numF3",
] as const;

// Persisted on the collection row: deterministic field-name -> slot mapping.
export const slotMapValidator = v.object({
  search: v.record(v.string(), v.string()), // fieldName -> "textN"
  strFilter: v.record(v.string(), v.string()), // fieldName -> "filtN"
  numFilter: v.record(v.string(), v.string()), // fieldName -> "numFN"
});
```

- [ ] **Step 4:** In `schema.ts`, add `slotMap: v.optional(slotMapValidator)` to BOTH `collectionDocValidator` (after the `pendingFields` line, ~line 73) and the `collections` table definition (after its `pendingFields` line, ~line 146). In `collectionDocValidator`:
```ts
    pendingFields: v.optional(v.array(v.string())),
    slotMap: v.optional(slotMapValidator),
```
In the `collections` table:
```ts
    pendingFields: v.optional(v.array(v.string())),
    slotMap: v.optional(slotMapValidator),
  }).index("by_name", ["name"]),
```

- [ ] **Step 5:** In `schema.ts` `defineSchema({...})`, add the `searchDocs` table. Place it directly after the `deletions` table (before the legacy `documents` table; the legacy tables stay for now and are removed in a later task). Spread `FILTER_SLOTS` into each of the nine search indexes:
```ts
  searchDocs: defineTable({
    collection: v.string(),
    docId: v.string(),
    // text0 = ALL searchFields concatenated (space-joined, no-queryBy fast path);
    // text1..text8 = one mapped searchField each.
    text0: v.optional(v.string()),
    text1: v.optional(v.string()),
    text2: v.optional(v.string()),
    text3: v.optional(v.string()),
    text4: v.optional(v.string()),
    text5: v.optional(v.string()),
    text6: v.optional(v.string()),
    text7: v.optional(v.string()),
    text8: v.optional(v.string()),
    // String equality-filter slots.
    filt0: v.optional(v.string()),
    filt1: v.optional(v.string()),
    filt2: v.optional(v.string()),
    filt3: v.optional(v.string()),
    filt4: v.optional(v.string()),
    filt5: v.optional(v.string()),
    filt6: v.optional(v.string()),
    filt7: v.optional(v.string()),
    // Numeric filter slots (real numeric columns for .eq + post-filtered ranges).
    numF0: v.optional(v.number()),
    numF1: v.optional(v.number()),
    numF2: v.optional(v.number()),
    numF3: v.optional(v.number()),
    // Stored projection returned in hits (storedFields.ts, kept).
    stored: v.any(),
  })
    .index("by_collection_doc", ["collection", "docId"])
    .searchIndex("s0", { searchField: "text0", filterFields: [...FILTER_SLOTS] })
    .searchIndex("s1", { searchField: "text1", filterFields: [...FILTER_SLOTS] })
    .searchIndex("s2", { searchField: "text2", filterFields: [...FILTER_SLOTS] })
    .searchIndex("s3", { searchField: "text3", filterFields: [...FILTER_SLOTS] })
    .searchIndex("s4", { searchField: "text4", filterFields: [...FILTER_SLOTS] })
    .searchIndex("s5", { searchField: "text5", filterFields: [...FILTER_SLOTS] })
    .searchIndex("s6", { searchField: "text6", filterFields: [...FILTER_SLOTS] })
    .searchIndex("s7", { searchField: "text7", filterFields: [...FILTER_SLOTS] })
    .searchIndex("s8", { searchField: "text8", filterFields: [...FILTER_SLOTS] }),
```

- [ ] **Step 6:** Run the new test and confirm it PASSES:
```
npx vitest run src/component/schema-slots.test.ts
```
Expected: PASS — 4 tests pass (FILTER_SLOTS shape, 9 search indexes with `sN.searchField === "textN"` and `filterFields === FILTER_SLOTS`, slotMapValidator shape, component registers).

- [ ] **Step 7:** Confirm existing suites still compile and pass against the additive schema change (no existing test references `searchDocs`/`slotMap`, so they must remain green):
```
npx vitest run src/component/configSync.test.ts src/component/collections.test.ts
```
Expected: PASS — both suites unchanged and green.

- [ ] **Step 8:** Commit:
```
git add src/component/schema.ts src/component/schema-slots.test.ts
git commit -m "feat: searchDocs generic-slot table + 9 search indexes; slotMap field

text0..text8/filt0..filt7/numF0..numF3 slot pool with shared FILTER_SLOTS
spread into s0..s8; optional slotMap on collections + collectionDocValidator.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `slotMap.ts` — deterministic `assignSlots(config)`, `SLOT_LIMITS`, over-cap throws

Create the pure, deterministic slot-assignment module. `assignSlots` maps each declared field to the lowest free slot in first-declared order (stable, so re-`sync` is idempotent), enforces the FINAL caps from `SLOT_LIMITS`, and throws a clear error naming the exceeded cap. No Convex ctx — pure function over a config object — so it is fully vitest-unit-testable.

**Files:**
- Create: `/Users/newuser/convex_component/src/component/slotMap.ts`
- Test: `/Users/newuser/convex_component/src/component/slotMap.test.ts` (Create)

**Interfaces:**
- Consumes from Task 1: `slotMapValidator` (the persisted shape; `assignSlots`'s return type is structurally `Infer<typeof slotMapValidator>`). `assignSlots` does NOT import the validator at runtime — it returns a plain object that matches it.
- Produces for later tasks (Task 3 `searchWrite.projectToSlots`, Task 4 `configSync`/`createCollection`):
  - `export type SlotMap = { search: Record<string, string>; strFilter: Record<string, string>; numFilter: Record<string, string> };`
  - `export type SlotConfig = { searchFields: string[]; filterFields?: { field: string; type: "string" | "number" }[] };`
  - `export const SLOT_LIMITS = { search: 8, strFilter: 8, numFilter: 4 } as const;` — note: search FIELD cap is 8 (text1..text8); `text0` is the always-on concatenation slot and is NOT consumed by a named field, so it is not counted.
  - `export function assignSlots(config: SlotConfig): SlotMap;` — deterministic, first-declared field gets lowest free slot index; throws `Error` whose message names the exceeded cap when a category has more fields than its limit.

Steps:

- [ ] **Step 1:** Write the failing unit tests. Create `/Users/newuser/convex_component/src/component/slotMap.test.ts` (pure vitest, no convexTest, no aggregates needed):
```ts
import { describe, it, expect } from "vitest";
import { assignSlots, SLOT_LIMITS } from "./slotMap";

describe("assignSlots", () => {
  it("maps search fields to text1.. in first-declared order (text0 reserved for concat)", () => {
    const m = assignSlots({ searchFields: ["title", "body", "brand"] });
    expect(m.search).toEqual({ title: "text1", body: "text2", brand: "text3" });
  });

  it("maps string and number filter fields to filtN / numFN independently", () => {
    const m = assignSlots({
      searchFields: ["title"],
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
        { field: "category", type: "string" },
        { field: "rating", type: "number" },
      ],
    });
    expect(m.search).toEqual({ title: "text1" });
    expect(m.strFilter).toEqual({ brand: "filt0", category: "filt1" });
    expect(m.numFilter).toEqual({ price: "numF0", rating: "numF1" });
  });

  it("is idempotent and stable: identical config yields identical mapping", () => {
    const cfg = {
      searchFields: ["title", "body"],
      filterFields: [
        { field: "brand", type: "string" as const },
        { field: "price", type: "number" as const },
      ],
    };
    expect(assignSlots(cfg)).toEqual(assignSlots(cfg));
  });

  it("keeps earlier fields on their slots when a new field is appended (stable re-sync)", () => {
    const before = assignSlots({ searchFields: ["title", "body"] });
    const after = assignSlots({ searchFields: ["title", "body", "tags"] });
    expect(after.search.title).toBe(before.search.title);
    expect(after.search.body).toBe(before.search.body);
    expect(after.search.tags).toBe("text3");
  });

  it("dedups a field declared twice to a single slot", () => {
    const m = assignSlots({ searchFields: ["title", "title", "body"] });
    expect(m.search).toEqual({ title: "text1", body: "text2" });
  });

  it("fills exactly to the search field cap (8 named -> text1..text8)", () => {
    const fields = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const m = assignSlots({ searchFields: fields });
    expect(Object.keys(m.search)).toHaveLength(SLOT_LIMITS.search);
    expect(m.search.a).toBe("text1");
    expect(m.search.h).toBe("text8");
  });

  it("throws naming the search cap when too many search fields are declared", () => {
    const fields = ["a", "b", "c", "d", "e", "f", "g", "h", "i"]; // 9 > 8
    expect(() => assignSlots({ searchFields: fields })).toThrow(/search field.*cap.*8/i);
  });

  it("throws naming the string-filter cap when too many string filters are declared", () => {
    const filterFields = Array.from({ length: 9 }, (_, i) => ({
      field: `f${i}`,
      type: "string" as const,
    }));
    expect(() => assignSlots({ searchFields: ["title"], filterFields })).toThrow(
      /string filter.*cap.*8/i,
    );
  });

  it("throws naming the numeric-filter cap when too many numeric filters are declared", () => {
    const filterFields = Array.from({ length: 5 }, (_, i) => ({
      field: `n${i}`,
      type: "number" as const,
    }));
    expect(() => assignSlots({ searchFields: ["title"], filterFields })).toThrow(
      /numeric filter.*cap.*4/i,
    );
  });

  it("exposes the FINAL caps", () => {
    expect(SLOT_LIMITS).toEqual({ search: 8, strFilter: 8, numFilter: 4 });
  });
});
```

- [ ] **Step 2:** Run the tests and confirm they FAIL (module does not exist yet):
```
npx vitest run src/component/slotMap.test.ts
```
Expected: FAIL — `Cannot find module './slotMap'`.

- [ ] **Step 3:** Create `/Users/newuser/convex_component/src/component/slotMap.ts` with the full implementation:
```ts
// Pure, deterministic field-name -> generic-slot assignment for the searchDocs
// table. First-declared field gets the lowest free slot, so re-running sync with
// the same (or appended) config is idempotent and stable. Caps mirror the FINAL
// slot pool baked into schema.ts; exceeding a cap throws a clear, cap-naming error.

export type SlotMap = {
  search: Record<string, string>; // fieldName -> "textN" (text1..text8; text0 = concat, unmapped)
  strFilter: Record<string, string>; // fieldName -> "filtN" (filt0..filt7)
  numFilter: Record<string, string>; // fieldName -> "numFN" (numF0..numF3)
};

export type SlotConfig = {
  searchFields: string[];
  filterFields?: { field: string; type: "string" | "number" }[];
};

// FINAL caps. search = 8 named searchFields -> text1..text8 (text0 is the
// always-on concatenation slot and is NOT a named-field slot, so not counted).
export const SLOT_LIMITS = { search: 8, strFilter: 8, numFilter: 4 } as const;

function assignCategory(
  fields: string[],
  prefix: string,
  startIndex: number,
  cap: number,
  label: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  let next = startIndex;
  for (const field of fields) {
    if (field in out) continue; // dedup: a field declared twice keeps its first slot
    if (next - startIndex >= cap) {
      throw new Error(
        `${label} cap exceeded: at most ${cap} ${label.toLowerCase()}s are supported ` +
          `(slot pool ${prefix}${startIndex}..${prefix}${startIndex + cap - 1})`,
      );
    }
    out[field] = `${prefix}${next}`;
    next += 1;
  }
  return out;
}

export function assignSlots(config: SlotConfig): SlotMap {
  // text0 is reserved for the all-searchFields concatenation, so named search
  // fields start at text1.
  const search = assignCategory(
    config.searchFields,
    "text",
    1,
    SLOT_LIMITS.search,
    "Search field",
  );

  const strFields = (config.filterFields ?? [])
    .filter((f) => f.type === "string")
    .map((f) => f.field);
  const numFields = (config.filterFields ?? [])
    .filter((f) => f.type === "number")
    .map((f) => f.field);

  const strFilter = assignCategory(
    strFields,
    "filt",
    0,
    SLOT_LIMITS.strFilter,
    "String filter",
  );
  const numFilter = assignCategory(
    numFields,
    "numF",
    0,
    SLOT_LIMITS.numFilter,
    "Numeric filter",
  );

  return { search, strFilter, numFilter };
}
```

- [ ] **Step 4:** Run the tests and confirm they PASS:
```
npx vitest run src/component/slotMap.test.ts
```
Expected: PASS — all assertions pass. Note the cap messages: search `"Search field cap exceeded: at most 8 search fields are supported (slot pool text1..text8)"` matches `/search field.*cap.*8/i`; string `"String filter cap exceeded: ... 8 string filters ... (slot pool filt0..filt7)"` matches `/string filter.*cap.*8/i`; numeric `"Numeric filter cap exceeded: ... 4 numeric filters ... (slot pool numF0..numF3)"` matches `/numeric filter.*cap.*4/i`.

- [ ] **Step 5:** Commit:
```
git add src/component/slotMap.ts src/component/slotMap.test.ts
git commit -m "feat: slotMap.assignSlots deterministic field->slot mapping + caps

First-declared field -> lowest free slot (text1..8 / filt0..7 / numF0..3),
stable on re-sync, dedups repeats, throws naming the exceeded cap.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```


### Task 3: `searchWrite.ts` — `projectToSlots(doc, col)` builds the `searchDocs` row

Pure slot-projection function: given a raw input doc and a loaded collection row (with `slotMap`), produce exactly the `searchDocs` row fields (`text0..text8`, `filt0..filt7`, `numF0..numF3`, `stored`). No DB access — testable as a unit per F1. `text0` = `tokenize`+space-join of every `searchField` value (the all-text fast-path slot); `textN` = the raw text of the single mapped `searchField`; `filtN` = `String()` of the mapped string-filter value; `numFN` = `Number()` of the mapped numeric-filter value, **skipped when NaN**; `stored` = the existing `project()` projection (storedFields / `indexRelevantFields`). Requires `col.slotMap`; per F9 it falls back to `assignSlots(col)` when absent (belt-and-suspenders), but the invariant is that create/apply has already persisted one.

**Files:**
- Create: `/Users/newuser/convex_component/src/component/searchWrite.ts`
- Test: `/Users/newuser/convex_component/src/component/searchWrite.test.ts`
- Modify: none

**Interfaces:**

Consumes from earlier tasks / kept modules (exact signatures — do NOT change):
- From Task 2 `slotMap.ts`: `export type SlotMap = { search: Record<string,string>; strFilter: Record<string,string>; numFilter: Record<string,string> }`; `export function assignSlots(config: { searchFields: string[]; filterFields?: {field:string;type:"string"|"number"}[] }): SlotMap`; `export const SLOT_LIMITS: { search: 8; strFilter: 8; numFilter: 4 }` (search counts text1..text8 = 8 mapped search slots, strFilter = 8, numFilter = 4).
- From Task 1 `schema.ts`: `searchDocs` table with columns `collection, docId, text0..text8, filt0..filt7, numF0..numF3, stored`; `collections` row gains optional `slotMap` object field (`search`/`strFilter`/`numFilter` records).
- Kept `tokenizer.ts`: `tokenize(text: string): string[]`.
- Kept `storedFields.ts`: `indexRelevantFields(c): string[]`.

Produces for later tasks:
- `export type SearchDocRow = { collection: string; docId: string; stored: Record<string,unknown> } & Partial<Record<"text0"|"text1"|"text2"|"text3"|"text4"|"text5"|"text6"|"text7"|"text8"|"filt0"|"filt1"|"filt2"|"filt3"|"filt4"|"filt5"|"filt6"|"filt7"|"numF0"|"numF1"|"numF2"|"numF3", string|number>>`
- `export function projectToSlots(doc: Record<string,unknown>, col: { searchFields: string[]; storedFields: "all"|"derived"|string[]; filterFields?: {field:string;type:"string"|"number"}[]; facetFields?: string[]; sortSpecs?: {field:string;order:"asc"|"desc"}[][]; rankProfiles?: Record<string, unknown>; slotMap?: SlotMap }): Omit<SearchDocRow, "collection"|"docId">` — returns the slot/stored fields only (caller adds `collection`/`docId`). Used by Task 4 `write.ts`.

**Steps:**

- [ ] **Step 1: Write the failing test.** Create `/Users/newuser/convex_component/src/component/searchWrite.test.ts` (pure unit, no convex-test needed — per F1 only DB-driving tests need the convexTest/aggregate setup):

```ts
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
```

- [ ] **Step 2: Run the test — expect FAIL.** `npx vitest run src/component/searchWrite.test.ts` — expected FAIL: `Failed to resolve import "./searchWrite"` (module does not exist yet).

- [ ] **Step 3: Implement `searchWrite.ts`.** Create `/Users/newuser/convex_component/src/component/searchWrite.ts`:

```ts
import { tokenize } from "./tokenizer";
import { indexRelevantFields } from "./storedFields";
import { assignSlots } from "./slotMap";
import type { SlotMap } from "./slotMap";

type Doc = Record<string, unknown>;

type SlotKey =
  | "text0" | "text1" | "text2" | "text3" | "text4"
  | "text5" | "text6" | "text7" | "text8"
  | "filt0" | "filt1" | "filt2" | "filt3"
  | "filt4" | "filt5" | "filt6" | "filt7"
  | "numF0" | "numF1" | "numF2" | "numF3";

export type SearchDocRow = {
  collection: string;
  docId: string;
  stored: Record<string, unknown>;
} & Partial<Record<SlotKey, string | number>>;

// Minimal shape projectToSlots needs from a collection row (a Convex Doc<"collections">
// is assignable to this).
type Col = {
  searchFields: string[];
  storedFields: "all" | "derived" | string[];
  filterFields?: { field: string; type: "string" | "number" }[];
  facetFields?: string[];
  sortSpecs?: { field: string; order: "asc" | "desc" }[][];
  rankProfiles?: Record<string, unknown>;
  slotMap?: SlotMap;
};

// Stored projection — identical semantics to project() in write.ts (kept).
function projectStored(doc: Doc, col: Col): Doc {
  const storedFields = col.storedFields;
  if (storedFields === "all") return doc;
  const keep = storedFields === "derived"
    ? indexRelevantFields(col as Parameters<typeof indexRelevantFields>[0])
    : storedFields;
  const out: Doc = {};
  for (const f of keep) {
    if (f in doc) out[f] = doc[f];
  }
  return out;
}

// Project a raw input doc onto the searchDocs slot columns + stored projection.
// Pure: no DB access. Requires col.slotMap (per F9 the create/apply step persists
// it before any upsert); falls back to assignSlots(col) as belt-and-suspenders.
export function projectToSlots(
  doc: Doc,
  col: Col,
): Omit<SearchDocRow, "collection" | "docId"> {
  const slotMap = col.slotMap ?? assignSlots(col);
  const row: Record<string, string | number> = {};

  // text0 = tokenized + space-joined concatenation of ALL searchFields (in order).
  const allTokens: string[] = [];
  for (const field of col.searchFields) {
    const value = doc[field];
    if (typeof value === "string") allTokens.push(...tokenize(value));
  }
  row.text0 = allTokens.join(" ");

  // textN = raw text of each mapped searchField.
  for (const [field, slot] of Object.entries(slotMap.search)) {
    const value = doc[field];
    if (typeof value === "string") row[slot] = value;
  }

  // filtN = String() of each mapped string-filter value.
  for (const [field, slot] of Object.entries(slotMap.strFilter)) {
    const value = doc[field];
    if (value === undefined || value === null) continue;
    row[slot] = String(value);
  }

  // numFN = Number() of each mapped numeric-filter value; skip NaN.
  for (const [field, slot] of Object.entries(slotMap.numFilter)) {
    const value = doc[field];
    if (value === undefined || value === null) continue;
    const num = Number(value);
    if (Number.isNaN(num)) continue;
    row[slot] = num;
  }

  return { ...(row as Partial<Record<SlotKey, string | number>>), stored: projectStored(doc, col) };
}
```

- [ ] **Step 4: Run the test — expect PASS.** `npx vitest run src/component/searchWrite.test.ts` — expected PASS: 7 passed. If the `text0` assertion fails, confirm `tokenize` order matches `searchFields` order; if a `textN`/`filtN` slot name mismatches, confirm `assignSlots` assigns first-declared → lowest free slot (`title`→`text1`, `body`→`text2`, `brand`→`filt0`, `price`→`numF0`).

- [ ] **Step 5: Commit.** `git add src/component/searchWrite.ts src/component/searchWrite.test.ts && git commit -m "feat: searchWrite.projectToSlots maps a doc onto searchDocs slot columns

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"`

---

### Task 4: Rewrite `write.ts` to write ONE `searchDocs` row via `projectToSlots`

Replace the inverted-index write path. `upsertInternal` now: loads the collection, `clearDoc`s the prior row, computes the slot row via `projectToSlots`, inserts ONE `searchDocs` row, and runs only the KEPT bounded ops — `addDoc`→docCount (new docs only), `incrementFacet`/`decrementFacet` on the **facetCounts TABLE** (F5), `addSortEntry`/`removeSortEntry`→sortIndex. ALL posting/term/trigram/filterPostings/facetPostings/docKeyCounter writes are dropped. `clearDoc` deletes the single `searchDocs` row and reverses the facet-table + sort aggregate ops (and `removeDoc` happens in `deleteDoc`). Per F9, create/apply must persist `slotMap` before any upsert; the test drives via `applyCollectionConfig` so a slotMap exists.

**Files:**
- Modify: `/Users/newuser/convex_component/src/component/write.ts`
- Test: `/Users/newuser/convex_component/src/component/write.test.ts` (replace — old assertions reference dropped `documents`/`docTerms` tables)
- Create: none

**Interfaces:**

Consumes from earlier tasks / kept modules (exact signatures):
- From Task 3 `searchWrite.ts`: `projectToSlots(doc, col): Omit<SearchDocRow, "collection"|"docId">`.
- Kept `collections.ts`: `requireCollection(ctx, name): Promise<Doc<"collections">>`.
- Kept `counters.ts`: `addDoc(ctx, collection, docId)`, `removeDoc(ctx, collection, docId)`.
- Kept `facetCounts.ts` (F5 — a TABLE, not an aggregate): `incrementFacet(ctx, collection, field, value)`, `decrementFacet(ctx, collection, field, value)`.
- Kept `sortIndex.ts`: `addSortEntry(ctx, collection, spec, stored, docId)`, `removeSortEntry(ctx, collection, spec, stored, docId)`.
- From Task 1 `schema.ts`: `searchDocs` table + `by_collection_doc` index `["collection","docId"]`; `collections.slotMap` persisted by Task 2's edits to `configSync.applyCollectionConfig`/`collections.createCollection`.

Produces for later tasks:
- `export const upsert`, `export const upsertMany`, `export const deleteDoc` (re-exported as `delete`) — public mutation surface, signatures UNCHANGED (`upsert: { collection, id, doc }`; `upsertMany: { collection, docs: {id,doc}[] }`; `delete: { collection, id }`), so the public API per the contract stays intact.
- `export const MAX_UPSERT_MANY_BATCH = 50` (TEMPORARY — Task 11 replaces it with the write-bounded `UPSERT_MANY_BATCH`; do not treat it as a surviving export. Cross-check #7.).

**Steps:**

- [ ] **Step 1: Replace the test file with the new searchDocs-shaped assertions.** Overwrite `/Users/newuser/convex_component/src/component/write.test.ts` (per F1: register BOTH aggregates; drive via `applyCollectionConfig` so `slotMap` exists per F9):

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
  registerAggregate(t, "sortIndex");
  // Drive via config sync so the collection row carries a slotMap (F9).
  await t.mutation(api.configSync.applyCollectionConfig, {
    config: {
      name: "products",
      searchFields: ["name", "description"],
      storedFields: ["name", "brand", "price"],
      filterFields: [
        { field: "brand", type: "string" },
        { field: "price", type: "number" },
      ],
      facetFields: ["brand"],
      sortSpecs: [[{ field: "price", order: "asc" }]],
    },
  });
  return t;
}

async function rowFor(t: any, docId: string) {
  return await t.run(async (ctx: any) =>
    ctx.db
      .query("searchDocs")
      .withIndex("by_collection_doc", (q: any) =>
        q.eq("collection", "products").eq("docId", docId),
      )
      .unique(),
  );
}

describe("write path (searchDocs)", () => {
  it("upsert writes ONE searchDocs row with correct slots + stored", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "running shoe", brand: "Acme", price: 50, secret: "x" },
    });
    const row = await rowFor(t, "p1");
    expect(row).not.toBeNull();
    // text0 = tokenized join of all searchFields
    expect(row.text0).toBe("red shoe running shoe");
    // mapped raw-text + filter slots (name->text1, description->text2, brand->filt0, price->numF0)
    expect(row.text1).toBe("Red Shoe");
    expect(row.text2).toBe("running shoe");
    expect(row.filt0).toBe("Acme");
    expect(row.numF0).toBe(50);
    // stored projection drops `secret`, keeps storedFields list
    expect(row.stored).toEqual({ name: "Red Shoe", brand: "Acme", price: 50 });
  });

  it("upsert increments docCount, facetCounts table, and sort aggregate", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "x", brand: "Acme", price: 50 },
    });
    const count = await t.run(async (ctx: any) => {
      const { DirectAggregate } = await import("@convex-dev/aggregate");
      return null; // count asserted indirectly below
    });
    const facet = await t.run(async (ctx: any) =>
      ctx.db
        .query("facetCounts")
        .withIndex("by_value", (q: any) =>
          q.eq("collection", "products").eq("field", "brand").eq("value", "Acme"),
        )
        .unique(),
    );
    expect(facet.count).toBe(1);
  });

  it("re-upsert replaces the row (no duplicate) and nets facet counts", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "x", brand: "Acme", price: 50 },
    });
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Blue Shoe", description: "y", brand: "Beta", price: 70 },
    });
    const rows = await t.run(async (ctx: any) =>
      ctx.db
        .query("searchDocs")
        .withIndex("by_collection_doc", (q: any) =>
          q.eq("collection", "products").eq("docId", "p1"),
        )
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].text1).toBe("Blue Shoe");
    expect(rows[0].filt0).toBe("Beta");
    expect(rows[0].numF0).toBe(70);
    // old facet value gone, new value present
    const acme = await t.run(async (ctx: any) =>
      ctx.db
        .query("facetCounts")
        .withIndex("by_value", (q: any) =>
          q.eq("collection", "products").eq("field", "brand").eq("value", "Acme"),
        )
        .unique(),
    );
    const beta = await t.run(async (ctx: any) =>
      ctx.db
        .query("facetCounts")
        .withIndex("by_value", (q: any) =>
          q.eq("collection", "products").eq("field", "brand").eq("value", "Beta"),
        )
        .unique(),
    );
    expect(acme).toBeNull();
    expect(beta.count).toBe(1);
  });

  it("delete removes the row and reverses facet count", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "x", brand: "Acme", price: 50 },
    });
    await t.mutation(api.write.delete, { collection: "products", id: "p1" });
    const row = await rowFor(t, "p1");
    expect(row).toBeNull();
    const acme = await t.run(async (ctx: any) =>
      ctx.db
        .query("facetCounts")
        .withIndex("by_value", (q: any) =>
          q.eq("collection", "products").eq("field", "brand").eq("value", "Acme"),
        )
        .unique(),
    );
    expect(acme).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL.** `npx vitest run src/component/write.test.ts` — expected FAIL: assertions read the `searchDocs` table / `text0`/`filt0` slots that the current posting-based `write.ts` never writes (rows null or slot fields undefined).

- [ ] **Step 3: Rewrite `write.ts`.** Overwrite `/Users/newuser/convex_component/src/component/write.ts`:

```ts
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc as ConvexDoc } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireCollection } from "./collections";
import { addDoc, removeDoc } from "./counters";
import { incrementFacet, decrementFacet } from "./facetCounts";
import { addSortEntry, removeSortEntry } from "./sortIndex";
import { projectToSlots } from "./searchWrite";

type Doc = Record<string, unknown>;
export const MAX_UPSERT_MANY_BATCH = 50;

// Load the single searchDocs row for (collection, docId), or null.
async function loadSearchDoc(ctx: MutationCtx, collection: string, docId: string) {
  return await ctx.db
    .query("searchDocs")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .unique();
}

// Delete a doc's single searchDocs row and reverse the kept aggregate/facet-table
// ops. Returns whether a row existed (so callers know whether to addDoc/removeDoc).
async function clearDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
  col: ConvexDoc<"collections">,
): Promise<{ existed: boolean }> {
  const existing = await loadSearchDoc(ctx, collection, docId);
  if (!existing) return { existed: false };

  const stored = existing.stored as Record<string, unknown>;

  // Facet invariant (preserved from the prior write path): incrementFacet on
  // upsert stringifies the RAW input value; this decrement stringifies the
  // PROJECTED stored value. They net to zero only because every projection mode
  // preserves facet-field values identically — keep facet fields in any explicit
  // storedFields projection.
  for (const field of col.facetFields ?? []) {
    const raw = stored[field];
    if (raw === undefined || raw === null) continue;
    await decrementFacet(ctx, collection, field, String(raw));
  }

  for (const spec of col.sortSpecs ?? []) {
    await removeSortEntry(ctx, collection, spec, stored, docId);
  }

  await ctx.db.delete(existing._id);
  return { existed: true };
}

async function upsertInternal(
  ctx: MutationCtx,
  collection: string,
  id: string,
  doc: Doc,
) {
  const col = await requireCollection(ctx, collection);
  const { existed } = await clearDoc(ctx, collection, id, col);

  // ONE searchDocs row via the pure slot projection (requires col.slotMap; F9
  // guarantees create/apply persisted it before any upsert).
  const slots = projectToSlots(doc, col);
  await ctx.db.insert("searchDocs", { collection, docId: id, ...slots });

  // Facet counts on the facetCounts TABLE (F5) — stringify the RAW input value.
  for (const field of col.facetFields ?? []) {
    const raw = doc[field];
    if (raw === undefined || raw === null) continue;
    await incrementFacet(ctx, collection, field, String(raw));
  }

  // Sort aggregate entries from the (possibly projected) stored values, keyed by
  // the raw doc — addSortEntry encodes stored via numField, matching reads.
  for (const spec of col.sortSpecs ?? []) {
    await addSortEntry(ctx, collection, spec, doc, id);
  }

  if (!existed) await addDoc(ctx, collection, id);
}

export const upsert = mutation({
  args: { collection: v.string(), id: v.string(), doc: v.any() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await upsertInternal(ctx, args.collection, args.id, args.doc as Doc);
    return null;
  },
});

export const deleteDoc = mutation({
  args: { collection: v.string(), id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const col = await requireCollection(ctx, args.collection);
    const { existed } = await clearDoc(ctx, args.collection, args.id, col);
    if (existed) await removeDoc(ctx, args.collection, args.id);
    return null;
  },
});

export const upsertMany = mutation({
  args: {
    collection: v.string(),
    docs: v.array(v.object({ id: v.string(), doc: v.any() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.docs.length > MAX_UPSERT_MANY_BATCH) {
      throw new Error(`upsertMany accepts at most ${MAX_UPSERT_MANY_BATCH} documents per call`);
    }
    await requireCollection(ctx, args.collection);
    for (const { id, doc } of args.docs) {
      await upsertInternal(ctx, args.collection, id, doc as Doc);
    }
    return null;
  },
});

export { deleteDoc as delete };
```

Note: `addSortEntry`/`removeSortEntry` are passed the RAW `doc` on insert and the PROJECTED `stored` on remove. Because `numField` reads the same numeric field from either, and sort fields are required to be in `storedFields`, encode/decode are stable — matching the kept sort-write convention. (If a later parity test shows a mismatch, switch `addSortEntry` to pass `slots.stored` instead of `doc`; keep both sides reading the projected stored.)

- [ ] **Step 4: Run the test — expect PASS.** `npx vitest run src/component/write.test.ts` — expected PASS: 4 passed. If `text2` (`description`→slot) assertion fails, confirm Task 2 `assignSlots` maps `searchFields` first-declared→lowest free (`name`→`text1`, `description`→`text2`). If the re-upsert facet test fails on `Acme` not being null, confirm `clearDoc` runs `decrementFacet` BEFORE the new `incrementFacet`.

- [ ] **Step 5: Verify no dropped-module imports remain and the file typechecks.** `npx tsc --noEmit -p . 2>&1 | grep -i "write.ts" || echo "write.ts clean"` — expected: `write.ts clean` (no references to `terms`/`postingChunks`/`docKeys`/`filterPostings`/`facetPostings`). The dropped modules themselves are removed in a later schema-cleanup task; this task only stops `write.ts` from importing them.

- [ ] **Step 6: Commit.** `git add src/component/write.ts src/component/write.test.ts && git commit -m "feat: rewrite write path to one searchDocs row via projectToSlots; drop posting/term writes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"`

### Task 5: Persist `slotMap` on create/apply (over-cap throws)

Extend `configSync.applyCollectionConfig` AND `collections.createCollection` to call `assignSlots(config)` (from `slotMap.ts`, **Task 2**) and persist the resulting `SlotMap` on the `collections` row. **(Cross-check #10: the `slotMap` field, `slotMapValidator`, and the `searchDocs` table were ALL added to `schema.ts` in Task 1 — this task must NOT re-add them; it only writes the value via `ctx.db.insert`/`patch`.)** The over-cap `Error` thrown by `assignSlots` (more search fields than text slots, more string-filter fields than `filt` slots, or more numeric-filter fields than `numF` slots) propagates out of both mutations naming the offending cap. Assignment is deterministic and stable (first-declared field -> lowest free slot), so re-applying the same config is idempotent (identical persisted map). This task RE-NUMBERS the implementation order: it MUST land before any write task (Task 6/7) so no collection can be upserted without a `slotMap`.

**Invariant (state explicitly in the commit + code comment):** `createCollection`/`applyCollectionConfig` MUST precede `upsert`. After this task every persisted collection row carries a `slotMap`.

**Files:**
- Modify: `/Users/newuser/convex_component/src/component/configSync.ts` (assign + persist `slotMap` in `applyCollectionConfig`, both create and update branches)
- Modify: `/Users/newuser/convex_component/src/component/collections.ts` (assign + persist `slotMap` in `createCollection`)
- (Do NOT modify `schema.ts` — the `slotMap` field on `collections`/`collectionDocValidator` and `slotMapValidator` were added in Task 1.)
- Test: `/Users/newuser/convex_component/src/component/slotMap-persist.test.ts` (new)

**Interfaces:**

Consumes from Task 1 (`slotMap.ts`):
```ts
// src/component/slotMap.ts
export type SlotMap = {
  search: Record<string, string>;    // fieldName -> "textN" (N in 1..8); text0 reserved (all-text concat)
  strFilter: Record<string, string>; // fieldName -> "filtN" (N in 0..7)
  numFilter: Record<string, string>; // fieldName -> "numFN" (N in 0..3)
};
export const SLOT_LIMITS: { search: 8; strFilter: 8; numFilter: 4 };
// assignSlots throws Error naming the cap when over-cap; deterministic + idempotent otherwise.
export function assignSlots(config: {
  searchFields: string[];
  filterFields?: { field: string; type: "string" | "number" }[];
}): SlotMap;
```

Consumes from existing modules (unchanged signatures):
```ts
// collections.ts
export async function loadCollection(ctx, name): Promise<collectionRow | null>;
export async function blockIfDeletionInProgress(ctx, name): Promise<void>;
export function validateCollectionConfig(args): void;
// schema.ts
export const collectionConfigValidator; // config arg shape
export const rankProfileValidator;
```

Produces for later tasks (Task 6/7 write + read):
```ts
// every persisted collections row now carries:
//   slotMap?: SlotMap
// applyCollectionConfig + createCollection both assign + persist it.
// collectionDocValidator now includes slotMap so getCollection returns it.
```

**Steps:**

- [ ] **Step 1:** Add the `slotMap` field to the schema. In `/Users/newuser/convex_component/src/component/schema.ts`, define the validator once near the top (after `sortSpecValidator`, around line 25) and reuse it in both the table definition and the doc validator:
```ts
// Persisted mapping from a collection's declared field names onto the fixed
// generic search/filter slot pool (see slotMap.ts). text0 is reserved for the
// all-searchFields concatenation and is NOT recorded here.
export const slotMapValidator = v.object({
  search: v.record(v.string(), v.string()),    // fieldName -> "text1".."text8"
  strFilter: v.record(v.string(), v.string()), // fieldName -> "filt0".."filt7"
  numFilter: v.record(v.string(), v.string()), // fieldName -> "numF0".."numF3"
});
```
Then add `slotMap: v.optional(slotMapValidator),` to the `collections` table definition (in the `defineTable({...})` block, after `pendingFields`, around line 146) and add the same `slotMap: v.optional(slotMapValidator),` line to `collectionDocValidator` (after its `pendingFields`, around line 73).

- [ ] **Step 2:** Write the failing test file `/Users/newuser/convex_component/src/component/slotMap-persist.test.ts` (uses the EXISTING convention per F1 — `convexTest` + `registerAggregate`, no `./test` import). This task drives no upsert/search, but register `docCount` to match the convention and keep parity with sibling tests:
```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob("./**/*.ts");

describe("slotMap persistence (applyCollectionConfig)", () => {
  it("persists a stable slotMap for <=8 search fields", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: {
        name: "p",
        searchFields: ["title", "body"],
        storedFields: "derived",
        filterFields: [
          { field: "brand", type: "string" },
          { field: "price", type: "number" },
        ],
      },
    });
    const c = await t.query(api.collections.getCollection, { name: "p" });
    expect(c?.slotMap).toEqual({
      search: { title: "text1", body: "text2" },
      strFilter: { brand: "filt0" },
      numFilter: { price: "numF0" },
    });
  });

  it("is idempotent on re-apply (same map)", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    const cfg = {
      name: "p",
      searchFields: ["title", "body"],
      storedFields: "derived" as const,
      filterFields: [{ field: "brand", type: "string" as const }],
    };
    await t.mutation(api.configSync.applyCollectionConfig, { config: cfg });
    const first = await t.query(api.collections.getCollection, { name: "p" });
    await t.mutation(api.configSync.applyCollectionConfig, { config: cfg });
    const second = await t.query(api.collections.getCollection, { name: "p" });
    expect(second?.slotMap).toEqual(first?.slotMap);
  });

  it("keeps earlier slot assignments stable when a new field is appended", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "p", searchFields: ["title"], storedFields: "derived" },
    });
    await t.mutation(api.configSync.applyCollectionConfig, {
      config: { name: "p", searchFields: ["title", "body"], storedFields: "derived" },
    });
    const c = await t.query(api.collections.getCollection, { name: "p" });
    expect(c?.slotMap?.search).toEqual({ title: "text1", body: "text2" });
  });

  it("throws naming the text-slot cap when >8 search fields declared", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    const searchFields = ["f1","f2","f3","f4","f5","f6","f7","f8","f9"]; // 9 > 8
    await expect(
      t.mutation(api.configSync.applyCollectionConfig, {
        config: { name: "p", searchFields, storedFields: "derived" },
      }),
    ).rejects.toThrow(/8 search/i);
  });

  it("throws naming the string-filter cap when >8 string filter fields declared", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    const filterFields = Array.from({ length: 9 }, (_, i) => ({
      field: `s${i}`,
      type: "string" as const,
    }));
    await expect(
      t.mutation(api.configSync.applyCollectionConfig, {
        config: { name: "p", searchFields: ["title"], storedFields: "derived", filterFields },
      }),
    ).rejects.toThrow(/8 string filter/i);
  });

  it("throws naming the numeric-filter cap when >4 numeric filter fields declared", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    const filterFields = Array.from({ length: 5 }, (_, i) => ({
      field: `n${i}`,
      type: "number" as const,
    }));
    await expect(
      t.mutation(api.configSync.applyCollectionConfig, {
        config: { name: "p", searchFields: ["title"], storedFields: "derived", filterFields },
      }),
    ).rejects.toThrow(/4 numeric filter/i);
  });

  it("createCollection persists slotMap too", async () => {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "q",
      searchFields: ["title"],
      storedFields: "derived",
      filterFields: [{ field: "brand", type: "string" }],
    });
    const c = await t.query(api.collections.getCollection, { name: "q" });
    expect(c?.slotMap).toEqual({
      search: { title: "text1" },
      strFilter: { brand: "filt0" },
      numFilter: {},
    });
  });
});
```

- [ ] **Step 2 (run, expect FAIL):** Run the new test — it MUST fail because `applyCollectionConfig`/`createCollection` do not yet persist `slotMap`:
```
npx vitest run src/component/slotMap-persist.test.ts
```
Expected: FAIL (assertions on `c?.slotMap` are `undefined`; the over-cap `.rejects.toThrow` cases also fail because no error is thrown yet). The error-message regexes assume `assignSlots` (Task 1) throws messages containing `"8 search"`, `"8 string filter"`, `"4 numeric filter"` — confirm Task 1's messages match these substrings; if Task 1 worded them differently, adjust the regexes here to match Task 1's exact wording (do NOT change `assignSlots`).

- [ ] **Step 3:** Implement in `applyCollectionConfig`. In `/Users/newuser/convex_component/src/component/configSync.ts`, add the import and compute+persist `slotMap` in both branches. Replace the import line and the handler body as follows.

Add to the import block at the top:
```ts
import { assignSlots } from "./slotMap";
```
Inside the handler, after `validateCollectionConfig({ ...config, storedFields });` (line 24) and before `const stored = ...`, compute the map (this is where the over-cap error throws, before any DB write):
```ts
    // Assign + persist the generic-slot mapping. Deterministic + stable
    // (first-declared field -> lowest free slot) so re-apply is idempotent.
    // assignSlots throws naming the cap if more fields than slots are declared.
    // INVARIANT: create/apply must precede upsert -> every row carries a slotMap.
    const slotMap = assignSlots({
      searchFields: config.searchFields,
      filterFields: config.filterFields,
    });
```
Add `slotMap` to the `next` object so both insert and patch persist it:
```ts
    const next = {
      name: config.name,
      searchFields: config.searchFields,
      storedFields,
      filterFields: config.filterFields,
      facetFields: config.facetFields,
      sortSpecs: config.sortSpecs,
      rankProfiles: config.rankProfiles,
      slotMap,
    };
```
The existing `ctx.db.insert("collections", { ...next, pendingFields: [] })` and `ctx.db.patch(stored._id, { ...next, pendingFields: pending })` now carry `slotMap` automatically via the spread. No other changes to the diff/pending logic.

- [ ] **Step 4:** Implement in `createCollection`. In `/Users/newuser/convex_component/src/component/collections.ts`, add the import near the other schema imports:
```ts
import { assignSlots } from "./slotMap";
```
In the `createCollection` handler, after `validateCollectionConfig({ ...args, storedFields });` (line 305) and before `ctx.db.insert`, compute the map and add it to the insert:
```ts
    const slotMap = assignSlots({
      searchFields: args.searchFields,
      filterFields: args.filterFields,
    });
    await ctx.db.insert("collections", {
      name: args.name,
      searchFields: args.searchFields,
      storedFields,
      filterFields: args.filterFields,
      facetFields: args.facetFields,
      sortSpecs: args.sortSpecs,
      rankProfiles: args.rankProfiles,
      slotMap,
    });
```

- [ ] **Step 5 (run, expect PASS):** Run the new test again:
```
npx vitest run src/component/slotMap-persist.test.ts
```
Expected: PASS (all 7 cases). Then run the existing config/collection suites to confirm no regression (they create collections through the same mutations, now also persisting `slotMap`):
```
npx vitest run src/component/configSync.test.ts src/component/collections.test.ts
```
Expected: PASS. If `getCollection` validation fails because the returned row now has `slotMap` but `collectionDocValidator` was not updated, re-check Step 1 added `slotMap` to `collectionDocValidator`.

- [ ] **Step 6 (commit):** Commit the change:
```
git add src/component/configSync.ts src/component/collections.ts src/component/schema.ts src/component/slotMap-persist.test.ts
git commit -m "$(cat <<'EOF'
feat: persist slotMap on createCollection/applyCollectionConfig; over-cap throws

assignSlots() now runs at config time in both create and apply paths,
persisting a deterministic, stable field->slot mapping on the collection
row and throwing the named over-cap error (8 search / 8 string filter /
4 numeric filter). Establishes the invariant that create/apply precede
upsert so no collection is written without a slotMap.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 6: `searchRead.ts` pure helpers — Candidate type, `reverifyAnd`, `synthScore`, `pickSearchSlot`

These are the in-memory, side-effect-free building blocks the hybrid search handler (Task 8) composes. No `ctx`, no DB reads — so they are fully vitest-testable under convex-test. Per F2 there is exactly ONE `Candidate` type and per F3 exactly ONE `synthScore`, both defined here and imported by Tasks 7/8.

**Files:**
- Create: `/Users/newuser/convex_component/src/component/searchRead.ts`
- Test: `/Users/newuser/convex_component/src/component/searchRead.test.ts`

**Interfaces:**

Consumes from earlier tasks (exact signatures — do NOT change):
- From `slotMap.ts` (Task 1/2): `export type SlotMap = { search: Record<string,string>; strFilter: Record<string,string>; numFilter: Record<string,string> };`
- From `tokenizer.ts` (kept): `export function tokenize(text: string): string[];`

Produces for later tasks (Tasks 7 and 8 import these):
- `export type Candidate = { docId: string; stored: Record<string, unknown>; slotText: string; rankPos: number };`
- `export function reverifyAnd(cands: Candidate[], queryTokens: string[]): Candidate[];`
- `export function synthScore(rankPos: number, total: number): number;`
- `export function pickSearchSlot(queryBy: string[] | undefined, slotMap: SlotMap): { indexName: string; slot: string };`

Steps:

- [ ] **Step 1:** Write the failing test file `/Users/newuser/convex_component/src/component/searchRead.test.ts` with REAL bodies. No convex-test / aggregate setup is needed here — these are pure functions.

```ts
import { describe, it, expect } from "vitest";
import {
  reverifyAnd,
  synthScore,
  pickSearchSlot,
  type Candidate,
} from "./searchRead";
import type { SlotMap } from "./slotMap";

function cand(docId: string, slotText: string, rankPos: number): Candidate {
  return { docId, stored: {}, slotText, rankPos };
}

describe("synthScore", () => {
  it("maps rank 0 of N to 1.0 and last to ~1/N", () => {
    expect(synthScore(0, 4)).toBe(1);
    expect(synthScore(3, 4)).toBe(0.25);
    expect(synthScore(1, 4)).toBe(0.75);
  });
  it("returns 0 when total <= 0", () => {
    expect(synthScore(0, 0)).toBe(0);
    expect(synthScore(5, -1)).toBe(0);
  });
});

describe("reverifyAnd", () => {
  it("keeps only candidates whose slotText contains ALL query tokens", () => {
    const cands = [
      cand("a", "red running shoes", 0),
      cand("b", "red shoes", 1),
      cand("c", "blue running shoes", 2),
    ];
    const kept = reverifyAnd(cands, ["red", "running"]);
    expect(kept.map((c) => c.docId)).toEqual(["a"]);
  });
  it("re-tokenizes slotText (case-insensitive, punctuation split) before matching", () => {
    const cands = [cand("a", "Red, RUNNING-Shoes!", 0)];
    const kept = reverifyAnd(cands, ["red", "running", "shoes"]);
    expect(kept.map((c) => c.docId)).toEqual(["a"]);
  });
  it("returns all candidates unchanged when queryTokens is empty", () => {
    const cands = [cand("a", "anything", 0), cand("b", "", 1)];
    expect(reverifyAnd(cands, [])).toEqual(cands);
  });
  it("preserves input order of surviving candidates", () => {
    const cands = [
      cand("a", "alpha beta", 0),
      cand("b", "beta", 1),
      cand("c", "alpha beta gamma", 2),
    ];
    const kept = reverifyAnd(cands, ["alpha", "beta"]);
    expect(kept.map((c) => c.docId)).toEqual(["a", "c"]);
  });
});

describe("pickSearchSlot", () => {
  const slotMap: SlotMap = {
    search: { title: "text1", body: "text2" },
    strFilter: {},
    numFilter: {},
  };
  it("single queryBy field -> its mapped textN slot + matching sN index", () => {
    expect(pickSearchSlot(["title"], slotMap)).toEqual({ indexName: "s1", slot: "text1" });
    expect(pickSearchSlot(["body"], slotMap)).toEqual({ indexName: "s2", slot: "text2" });
  });
  it("no queryBy -> s0/text0 (all-text concatenation)", () => {
    expect(pickSearchSlot(undefined, slotMap)).toEqual({ indexName: "s0", slot: "text0" });
    expect(pickSearchSlot([], slotMap)).toEqual({ indexName: "s0", slot: "text0" });
  });
  it("multiple queryBy fields -> s0/text0 (all-text)", () => {
    expect(pickSearchSlot(["title", "body"], slotMap)).toEqual({ indexName: "s0", slot: "text0" });
  });
  it("throws when the single queryBy field is not a mapped search field", () => {
    expect(() => pickSearchSlot(["nope"], slotMap)).toThrow(/not a searchable field/i);
  });
});
```

- [ ] **Step 2:** Run the test and watch it FAIL (module does not exist yet).

```
npx vitest run src/component/searchRead.test.ts
```

Expected: FAIL — `Failed to resolve import "./searchRead"` (and `./slotMap` if Task 1/2 not yet merged; if so this task is gated on those).

- [ ] **Step 3:** Implement `/Users/newuser/convex_component/src/component/searchRead.ts` with the REAL pure helpers. Note `text0` is the all-searchFields concatenation slot (index `s0`); `textN` maps to index `sN` by stripping the `text` prefix.

```ts
import { tokenize } from "./tokenizer";
import type { SlotMap } from "./slotMap";

// F2: the ONE candidate type shared across read + rank + facet layers.
// rankPos = native result index (0-based); slotText = the searched slot's raw
// text, used for AND re-verify and highlighting.
export type Candidate = {
  docId: string;
  stored: Record<string, unknown>;
  slotText: string;
  rankPos: number;
};

// F3: the ONE synthScore. rank 0 of N -> 1.0, last (N-1) -> ~1/N.
export function synthScore(rankPos: number, total: number): number {
  return total <= 0 ? 0 : (total - rankPos) / total;
}

// Native search is OR-by-relevance. Re-impose AND app-side: keep only candidates
// whose slotText (re-tokenized) contains every query token. Empty token list ->
// pass-through. Order is preserved.
export function reverifyAnd(cands: Candidate[], queryTokens: string[]): Candidate[] {
  if (queryTokens.length === 0) return cands;
  return cands.filter((c) => {
    const present = new Set(tokenize(c.slotText));
    return queryTokens.every((tok) => present.has(tok));
  });
}

// Choose which native search index to query. A single queryBy field maps to its
// dedicated textN slot (index sN); zero or multiple fields fall back to text0
// (s0), the concatenation of ALL searchFields.
export function pickSearchSlot(
  queryBy: string[] | undefined,
  slotMap: SlotMap,
): { indexName: string; slot: string } {
  if (queryBy && queryBy.length === 1) {
    const field = queryBy[0];
    const slot = slotMap.search[field];
    if (!slot) {
      throw new Error(`queryBy "${field}" is not a searchable field for this collection`);
    }
    const indexName = "s" + slot.slice("text".length);
    return { indexName, slot };
  }
  return { indexName: "s0", slot: "text0" };
}
```

- [ ] **Step 4:** Run the test and watch it PASS.

```
npx vitest run src/component/searchRead.test.ts
```

Expected: PASS — all `synthScore`, `reverifyAnd`, `pickSearchSlot` cases green. In particular `synthScore(0,4) === 1` and `synthScore(3,4) === 0.25`.

- [ ] **Step 5:** Commit.

```
git add src/component/searchRead.ts src/component/searchRead.test.ts
git commit -m "feat: searchRead pure helpers (Candidate, reverifyAnd, synthScore, pickSearchSlot)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Filter & rank RESOLVERS — `resolveEqFilters`, `resolveRankProfile` (per F7)

These translate the runtime `filterBy` DSL and `rank` arg into a form the hybrid handler (Task 8) can execute against `searchDocs`: equality clauses on mapped fields become native `.eq` on `filtN`/`numFN` slots; ranges and anything `.eq` cannot express become an in-memory `Predicate` applied over the ≤K candidate window (bounded reads, F7). The rank-profile lookup + weight-id validation is extracted VERBATIM from `search.ts` lines 93-104. Both resolvers are pure (no DB reads) so they are vitest-testable.

**Files:**
- Create: `/Users/newuser/convex_component/src/component/filterRank.ts`
- Test: `/Users/newuser/convex_component/src/component/filterRank.test.ts`

**Interfaces:**

Consumes from earlier tasks / kept modules (exact signatures — do NOT change):
- From `slotMap.ts` (Task 1/2): `export type SlotMap = { search: Record<string,string>; strFilter: Record<string,string>; numFilter: Record<string,string> };`
- From `filter.ts` (kept):
  - `export type Predicate = (stored: Record<string, unknown>) => boolean;`
  - `export type FieldType = "string" | "number";`
  - `export type Ast = { kind:"and"; left:Ast; right:Ast } | { kind:"or"; left:Ast; right:Ast } | { kind:"exact"; field:string; type:FieldType; value:string } | { kind:"inSet"; field:string; type:FieldType; values:string[] } | { kind:"cmp"; field:string; op:">"|">="|"<"|"<="; num:number } | { kind:"range"; field:string; lo:number; hi:number };`
  - `export function parseFilterAst(input: string, fieldTypes: Record<string, FieldType>): Ast;`
  - `export function astToPredicate(ast: Ast): Predicate;`
- From `schema.ts` (kept): `export type RankProfile = { base: string; window?: number; terms: RankTerm[] };`
- From `score.ts` (kept): `export type RankContext = { now?: number; origin?: { lat:number; lng:number }; sets?: Record<string,string[]> };` and `export type RankTerm` (re-exported via schema).
- The collection row shape (from `requireCollection`/`loadCollection`): has optional `rankProfiles?: Record<string, RankProfile>` and `slotMap?: SlotMap`.

Produces for later tasks (Task 8 imports these):
- `export type EqClause = { slot: string; value: string | number };`
- `export type ResolvedFilters = { eq: EqClause[]; postFilter: Predicate | null };`
- `export function resolveEqFilters(filterBy: string, slotMap: SlotMap, fieldTypes: Record<string, FieldType>): ResolvedFilters;`
- `export type ResolvedRank = { profile: RankProfile; weights?: Record<string, number>; context?: RankContext };`
- `export function resolveRankProfile(collection: { rankProfiles?: Record<string, RankProfile> }, rank: { profile: string; weights?: Record<string, number>; context?: RankContext } | undefined): ResolvedRank | undefined;`

Steps:

- [ ] **Step 1:** Write the failing test `/Users/newuser/convex_component/src/component/filterRank.test.ts`. Pure functions — no convex-test/aggregate setup.

```ts
import { describe, it, expect } from "vitest";
import {
  resolveEqFilters,
  resolveRankProfile,
} from "./filterRank";
import type { SlotMap } from "./slotMap";
import type { FieldType } from "./filter";
import type { RankProfile } from "./schema";

const slotMap: SlotMap = {
  search: { title: "text1" },
  strFilter: { brand: "filt0", category: "filt1" },
  numFilter: { price: "numF0", year: "numF1" },
};
const fieldTypes: Record<string, FieldType> = {
  brand: "string",
  category: "string",
  price: "number",
  year: "number",
};

describe("resolveEqFilters", () => {
  it("string equality on a mapped field -> native .eq on its filt slot, no postFilter", () => {
    const r = resolveEqFilters('brand:Nike', slotMap, fieldTypes);
    expect(r.eq).toEqual([{ slot: "filt0", value: "Nike" }]);
    expect(r.postFilter).toBeNull();
  });

  it("numeric equality on a mapped field -> native .eq on its numF slot", () => {
    const r = resolveEqFilters('year:2024', slotMap, fieldTypes);
    expect(r.eq).toEqual([{ slot: "numF1", value: 2024 }]);
    expect(r.postFilter).toBeNull();
  });

  it("ANDed equalities -> multiple native .eq clauses, no postFilter", () => {
    const r = resolveEqFilters('brand:Nike && category:shoes', slotMap, fieldTypes);
    expect(r.eq).toEqual([
      { slot: "filt0", value: "Nike" },
      { slot: "filt1", value: "shoes" },
    ]);
    expect(r.postFilter).toBeNull();
  });

  it("a numeric range -> a postFilter Predicate (no native eq for it)", () => {
    const r = resolveEqFilters('price:[10..20]', slotMap, fieldTypes);
    expect(r.eq).toEqual([]);
    expect(r.postFilter).not.toBeNull();
    const p = r.postFilter!;
    expect(p({ price: 15 })).toBe(true);
    expect(p({ price: 5 })).toBe(false);
    expect(p({ price: 25 })).toBe(false);
  });

  it("comparator -> postFilter Predicate", () => {
    const r = resolveEqFilters('price:>100', slotMap, fieldTypes);
    expect(r.eq).toEqual([]);
    const p = r.postFilter!;
    expect(p({ price: 150 })).toBe(true);
    expect(p({ price: 50 })).toBe(false);
  });

  it("equality AND range -> eq for the equality, postFilter for the range", () => {
    const r = resolveEqFilters('brand:Nike && price:[10..20]', slotMap, fieldTypes);
    expect(r.eq).toEqual([{ slot: "filt0", value: "Nike" }]);
    expect(r.postFilter).not.toBeNull();
    const p = r.postFilter!;
    expect(p({ price: 15 })).toBe(true);
    expect(p({ price: 99 })).toBe(false);
  });

  it("OR anywhere -> whole thing becomes a postFilter (cannot push to native eq)", () => {
    const r = resolveEqFilters('brand:Nike || brand:Adidas', slotMap, fieldTypes);
    expect(r.eq).toEqual([]);
    expect(r.postFilter).not.toBeNull();
    const p = r.postFilter!;
    expect(p({ brand: "Nike" })).toBe(true);
    expect(p({ brand: "Adidas" })).toBe(true);
    expect(p({ brand: "Puma" })).toBe(false);
  });

  it("inSet -> postFilter (native eq is single-value)", () => {
    const r = resolveEqFilters('brand:[Nike,Adidas]', slotMap, fieldTypes);
    expect(r.eq).toEqual([]);
    const p = r.postFilter!;
    expect(p({ brand: "Adidas" })).toBe(true);
    expect(p({ brand: "Puma" })).toBe(false);
  });

  it("empty/whitespace filterBy -> no eq, no postFilter", () => {
    expect(resolveEqFilters("", slotMap, fieldTypes)).toEqual({ eq: [], postFilter: null });
    expect(resolveEqFilters("   ", slotMap, fieldTypes)).toEqual({ eq: [], postFilter: null });
  });

  it("equality on a field with no slot -> postFilter (cannot push to native)", () => {
    const sm: SlotMap = { search: {}, strFilter: {}, numFilter: {} };
    const r = resolveEqFilters('brand:Nike', sm, fieldTypes);
    expect(r.eq).toEqual([]);
    expect(r.postFilter).not.toBeNull();
    expect(r.postFilter!({ brand: "Nike" })).toBe(true);
  });
});

const profile: RankProfile = {
  base: "relevance",
  terms: [
    { id: "rel", type: "relevance", weight: 1 },
    { id: "pop", type: "field", weight: 2, field: "popularity" },
  ],
};

describe("resolveRankProfile", () => {
  it("returns undefined when rank arg is absent", () => {
    expect(resolveRankProfile({ rankProfiles: { default: profile } }, undefined)).toBeUndefined();
  });

  it("resolves a known profile and passes weights/context through", () => {
    const r = resolveRankProfile(
      { rankProfiles: { default: profile } },
      { profile: "default", weights: { pop: 5 }, context: { now: 123 } },
    );
    expect(r).toEqual({ profile, weights: { pop: 5 }, context: { now: 123 } });
  });

  it("throws on an unknown rank profile naming it", () => {
    expect(() =>
      resolveRankProfile({ rankProfiles: { default: profile } }, { profile: "nope" }),
    ).toThrow(/Unknown rank profile "nope"/);
  });

  it("throws on a weight-id override that is not a term id, naming both", () => {
    expect(() =>
      resolveRankProfile(
        { rankProfiles: { default: profile } },
        { profile: "default", weights: { bogus: 3 } },
      ),
    ).toThrow(/Unknown rank weight override "bogus" for profile "default"/);
  });

  it("throws unknown profile when the collection has no rankProfiles at all", () => {
    expect(() => resolveRankProfile({}, { profile: "default" })).toThrow(
      /Unknown rank profile "default"/,
    );
  });
});
```

- [ ] **Step 2:** Run the test and watch it FAIL (module missing).

```
npx vitest run src/component/filterRank.test.ts
```

Expected: FAIL — `Failed to resolve import "./filterRank"`.

- [ ] **Step 3:** Implement `/Users/newuser/convex_component/src/component/filterRank.ts`. `resolveEqFilters` walks the parsed AST: a top-level conjunction of `exact` clauses on slot-mapped fields pushes down to native `.eq`; everything else (ranges, comparators, inSet, OR, unmapped equality) falls back to the kept `astToPredicate` over the whole expression's residual. Per F7 the residual postFilter runs in memory over the ≤K candidate window. `resolveRankProfile` is the verbatim extraction of `search.ts` lines 93-104.

```ts
import {
  parseFilterAst,
  astToPredicate,
  type Ast,
  type Predicate,
  type FieldType,
} from "./filter";
import type { SlotMap } from "./slotMap";
import type { RankProfile } from "./schema";
import type { RankContext } from "./score";

export type EqClause = { slot: string; value: string | number };
export type ResolvedFilters = { eq: EqClause[]; postFilter: Predicate | null };

// Try to express `ast` as a conjunction of native-.eq clauses on slot-mapped
// fields. Collects pushable EqClauses into `eq` and the residual (anything native
// .eq cannot do) into `residual` Asts. Returns false if the whole subtree is
// non-pushable (e.g. an OR), in which case the caller keeps the entire subtree
// as residual. Equality on an unmapped field is not pushable -> residual.
function collect(
  ast: Ast,
  slotMap: SlotMap,
  eq: EqClause[],
  residual: Ast[],
): void {
  switch (ast.kind) {
    case "and":
      collect(ast.left, slotMap, eq, residual);
      collect(ast.right, slotMap, eq, residual);
      return;
    case "exact": {
      const slot =
        ast.type === "number"
          ? slotMap.numFilter[ast.field]
          : slotMap.strFilter[ast.field];
      if (slot) {
        eq.push({ slot, value: ast.type === "number" ? Number(ast.value) : ast.value });
      } else {
        residual.push(ast);
      }
      return;
    }
    // or / inSet / cmp / range: not expressible as a single native .eq -> residual.
    default:
      residual.push(ast);
      return;
  }
}

export function resolveEqFilters(
  filterBy: string,
  slotMap: SlotMap,
  fieldTypes: Record<string, FieldType>,
): ResolvedFilters {
  if (!filterBy || filterBy.trim() === "") return { eq: [], postFilter: null };
  const ast = parseFilterAst(filterBy, fieldTypes);
  const eq: EqClause[] = [];
  const residual: Ast[] = [];
  collect(ast, slotMap, eq, residual);
  if (residual.length === 0) return { eq, postFilter: null };
  // Combine residual clauses with AND, then build one in-memory Predicate.
  const combined = residual.reduce((left, right) => ({ kind: "and", left, right }));
  return { eq, postFilter: astToPredicate(combined) };
}

export type ResolvedRank = {
  profile: RankProfile;
  weights?: Record<string, number>;
  context?: RankContext;
};

// Verbatim extraction of search.ts lines 93-104 (rank profile lookup + weight-id
// validation), returning the resolved profile + pass-through weights/context.
export function resolveRankProfile(
  collection: { rankProfiles?: Record<string, RankProfile> },
  rank: { profile: string; weights?: Record<string, number>; context?: RankContext } | undefined,
): ResolvedRank | undefined {
  const rankProfile = rank ? collection.rankProfiles?.[rank.profile] : undefined;
  if (rank && !rankProfile) {
    throw new Error(`Unknown rank profile "${rank.profile}"`);
  }
  if (rank?.weights && rankProfile) {
    const termIds = new Set(rankProfile.terms.map((t) => t.id));
    for (const id of Object.keys(rank.weights)) {
      if (!termIds.has(id)) {
        throw new Error(`Unknown rank weight override "${id}" for profile "${rank.profile}"`);
      }
    }
  }
  if (!rankProfile) return undefined;
  return { profile: rankProfile, weights: rank!.weights, context: rank!.context };
}
```

- [ ] **Step 4:** Run the test and watch it PASS.

```
npx vitest run src/component/filterRank.test.ts
```

Expected: PASS — equality pushes to native `.eq` slot clauses; ranges/comparators/inSet/OR/unmapped-equality become a `postFilter` Predicate; unknown profile and bad weight-id both throw with the named identifiers.

- [ ] **Step 5:** Commit.

```
git add src/component/filterRank.ts src/component/filterRank.test.ts
git commit -m "feat: filter/rank resolvers (resolveEqFilters eq+postFilter, resolveRankProfile)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 8: Wire the text-query branch into `search.ts` via `runTextQuery` (+ empty-q filter path)

This task rebuilds the `search` query handler's retrieval core on top of the native `searchDocs` slot pool. It introduces `runTextQuery` (native `withSearchIndex(...).take(K)` -> `Candidate[]`) and the empty-q + filter path (F8: `by_collection_doc` scan + in-memory eq/postFilter, bounded `take`). The pure, deterministic pieces (Candidate building shape, `synthScore`, `reverifyAnd`, 1-based paging math) are vitest-tested. **Native OR-by-relevance retrieval is NOT vitest-testable under convex-test (see header NOTE) and is asserted only in the Task-10 smoke task (`npx convex run`).**

**Files:**
- Modify: `/Users/newuser/convex_component/src/component/searchRead.ts` (add ONLY `runTextQuery`, `runEmptyQFilterQuery`, `clampK`. **Cross-check #3: `Candidate`, `synthScore`, `reverifyAnd`, and `pickSearchSlot` were already created and unit-tested in Task 6 — do NOT re-declare them or re-`import { tokenize }`; `runTextQuery` must CALL `pickSearchSlot(args.queryBy, slotMap)` rather than recompute slot selection.**)
- Modify: `/Users/newuser/convex_component/src/component/search.ts` (replace the text path + filter-only path; keep envelope + 1-based paging)
- Test: `/Users/newuser/convex_component/src/component/searchRead.test.ts` (extend with paging-math + a convex-test empty-q+filter run only; `synthScore`/`reverifyAnd` are already tested in Task 6)

**Interfaces:**

Consumes (from earlier tasks — exact signatures):
- Task 1 `slotMap.ts`: `type SlotMap = { search: Record<string,string>; strFilter: Record<string,string>; numFilter: Record<string,string> }`; `assignSlots(config): SlotMap`; `SLOT_LIMITS`.
- Task 7 `searchRead.ts` (already created there): `resolveEqFilters(filterBy: string, slotMap: SlotMap): { eq: { slot: string; value: string | number }[]; postFilter: Predicate | null }`; `resolveRankProfile(collection, rank): { profile: RankProfile; weights?: Record<string,number>; context?: RankContext } | undefined`.
- Kept `tokenizer.ts`: `tokenize(text: string): string[]`.
- Kept `highlight.ts`: `highlightField(value: string, matchedTerms: Set<string>): { snippet: string; matched_tokens: string[] } | null`.
- Kept `filter.ts`: `type Predicate = (stored: Record<string, unknown>) => boolean`.
- Kept `collections.ts`: `requireCollection(ctx, name)` (returns the collection row incl. `slotMap`, `searchFields`).
- Kept `counters.ts`: `collectionCount(ctx, collection): Promise<number>`.
- Schema (Task 1/2): `searchDocs` table with `.index("by_collection_doc", ["collection","docId"])`, columns `text0..text8`, `filt0..filt7`, `numF0..numF3`, `stored`; native indexes `s0..s8`.

Consumes from Task 6 `searchRead.ts` (already created + tested there — do NOT redefine):
- `type Candidate = { docId: string; stored: Record<string, unknown>; slotText: string; rankPos: number }` (THE one shared candidate type — F2).
- `synthScore(rankPos: number, total: number): number` (THE one synth score — F3).
- `reverifyAnd(candidates: Candidate[], queryTokens: string[]): Candidate[]`.
- `pickSearchSlot(queryBy: string[] | undefined, slotMap: SlotMap): { indexName: string; slot: string }`.

Produces (consumed by Task 9):
- `async function runTextQuery(ctx, collection, args, slotMap): Promise<{ candidates: Candidate[]; queryTokens: string[]; searchedSlot: string; found_approximate: boolean }>`.
- `async function runEmptyQFilterQuery(ctx, collection, eq, postFilter, take): Promise<Candidate[]>`.
- `function clampK(window: number): number` (clamps to `[1, 1024]`).

**Steps:**

- [ ] **Step 1:** Write the failing test for the NEW symbols only (`clampK` + the empty-q+filter run). `Candidate`/`synthScore`/`reverifyAnd` are already covered by Task 6 — do not re-test them here.

  Append to `/Users/newuser/convex_component/src/component/searchRead.test.ts`:
  ```ts
  import { clampK, type Candidate } from "./searchRead";

  describe("clampK", () => {
    it("clamps the re-rank window into [1, 1024]", () => {
      expect(clampK(0)).toBe(1);
      expect(clampK(200)).toBe(200);
      expect(clampK(5000)).toBe(1024);
    });
  });
  ```
  Run: `npx vitest run src/component/searchRead.test.ts -t clampK`
  Expected: FAIL (`clampK` not exported yet).

  > **Cross-check #3:** `Candidate`, `synthScore`, and `reverifyAnd` are NOT created here — Task 6 already created and unit-tested them in `searchRead.ts`. This task only adds `clampK`, `runTextQuery`, and `runEmptyQFilterQuery`, and CONSUMES the Task-6 symbols (import them, don't redeclare; do not add a second `import { tokenize }`).

- [ ] **Step 2:** Implement `clampK` in `/Users/newuser/convex_component/src/component/searchRead.ts` (add below the existing Task-6 helpers):
  ```ts
  // Clamp the re-rank window to native search's hard ceiling. Native .take above
  // 1024 THROWS ("scanned too many documents"), so K is always in [1, 1024].
  export function clampK(window: number): number {
    return Math.min(1024, Math.max(1, Math.floor(window)));
  }
  ```
  Run: `npx vitest run src/component/searchRead.test.ts -t clampK`
  Expected: PASS.

- [ ] **Step 3 (was Step 5):** Write the failing test for `runEmptyQFilterQuery` (F8 — deterministic, convex-test-runnable). Append to `searchRead.test.ts`:
  ```ts
  import { convexTest } from "convex-test";
  import { register as registerAggregate } from "@convex-dev/aggregate/test";
  import schema from "./schema";
  import { api } from "./_generated/api";
  const modules = import.meta.glob("./**/*.ts");

  describe("runEmptyQFilterQuery (F8 by_collection_doc + in-memory eq/postFilter)", () => {
    it("returns only rows matching the native eq AND the in-memory postFilter, bounded by take", async () => {
      const t = convexTest(schema, modules);
      registerAggregate(t, "docCount");
      registerAggregate(t, "sortIndex");
      await t.mutation(api.collections.createCollection, {
        name: "shop",
        searchFields: ["name"],
        filterFields: [
          { field: "brand", type: "string" },
          { field: "price", type: "number" },
        ],
      });
      await t.mutation(api.write.upsertMany, {
        collection: "shop",
        docs: [
          { id: "a", doc: { name: "x", brand: "acme", price: 10 } },
          { id: "b", doc: { name: "y", brand: "acme", price: 99 } },
          { id: "c", doc: { name: "z", brand: "other", price: 10 } },
        ],
      });
      // brand:acme (native eq) AND price < 50 (in-memory postFilter) -> only "a".
      const r = await t.query(api.search.search, {
        collection: "shop",
        q: "",
        filterBy: 'brand:acme && price:<50',
      });
      expect(r.hits.map((h: any) => h.id).sort()).toEqual(["a"]);
      expect(r.found).toBe(1);
    });
  });
  ```
  Run: `npx vitest run src/component/searchRead.test.ts -t runEmptyQFilterQuery`
  Expected: FAIL (search.ts still on the old filter path / `runEmptyQFilterQuery` absent).

- [ ] **Step 6:** Implement `runEmptyQFilterQuery` in `searchRead.ts`. Empty-q + filter must NOT use a native search (needs a query string); scan `by_collection_doc` scoped to the collection, apply eq slots + the in-memory postFilter, bounded by a `take` window:
  ```ts
  import type { QueryCtx } from "./_generated/server";

  // F8: empty-q + filter path. Native search needs a query string, so for the
  // browse-with-filter case we scan by_collection_doc (scoped to the collection),
  // apply the native-expressible eq() in memory + the residual postFilter, and
  // bound the read with take(). Deterministic + convex-test-runnable.
  export async function runEmptyQFilterQuery(
    ctx: QueryCtx,
    collection: string,
    eq: { slot: string; value: string | number }[],
    postFilter: ((stored: Record<string, unknown>) => boolean) | null,
    take: number,
  ): Promise<Candidate[]> {
    const rows = await ctx.db
      .query("searchDocs")
      .withIndex("by_collection_doc", (q) => q.eq("collection", collection))
      .take(Math.max(1, take));
    const out: Candidate[] = [];
    let pos = 0;
    for (const row of rows) {
      const slotsOk = eq.every((e) => (row as Record<string, unknown>)[e.slot] === e.value);
      if (!slotsOk) continue;
      const stored = (row.stored ?? {}) as Record<string, unknown>;
      if (postFilter && !postFilter(stored)) continue;
      out.push({ docId: row.docId, stored, slotText: "", rankPos: pos++ });
    }
    return out;
  }
  ```
  Run: `npx vitest run src/component/searchRead.test.ts -t runEmptyQFilterQuery`
  Expected: still FAIL until `search.ts` routes the empty-q+filter case here (next steps wire it).

- [ ] **Step 7:** Implement `runTextQuery` + the `K` clamp in `searchRead.ts` (native retrieval — vitest cannot exercise this; asserted in Task 10 smoke). Place after `runEmptyQFilterQuery`:
  ```ts
  const MAX_NATIVE_TAKE = 1024;
  export function clampK(window: number): number {
    return Math.min(MAX_NATIVE_TAKE, Math.max(1, Math.floor(window)));
  }

  // Native text retrieval over the slot pool. Picks the slot: a single queryBy
  // field maps to its search slot via slotMap.search; otherwise text0 (all-text).
  // Always .eq("collection", name)-scoped; native-expressible eq filters chained
  // on filtN/numFN. .take(K), K = clamp(window, 1, 1024). Builds Candidate[]
  // (rankPos = native index, slotText = the searched slot's text).
  export async function runTextQuery(
    ctx: QueryCtx,
    collection: { name: string; slotMap?: SlotMap | undefined; searchFields: string[] },
    args: { q: string; queryBy?: string[] | undefined },
    slotMap: SlotMap,
    eq: { slot: string; value: string | number }[],
    window: number,
  ): Promise<{ candidates: Candidate[]; searchedSlot: string; indexName: string; found_approximate: boolean }> {
    const K = clampK(window);
    // slot selection: single queryBy field -> its mapped slot; else text0.
    let slot = "text0";
    if (args.queryBy && args.queryBy.length === 1) {
      const mapped = slotMap.search[args.queryBy[0]];
      if (mapped) slot = mapped;
    }
    const indexName = "s" + slot.slice("text".length); // text3 -> s3
    const q = args.q;
    const rows = await ctx.db
      .query("searchDocs")
      .withSearchIndex(indexName as any, (b) => {
        let f = b.search(slot as any, q).eq("collection", collection.name);
        for (const e of eq) f = f.eq(e.slot as any, e.value);
        return f;
      })
      .take(K);
    const candidates: Candidate[] = rows.map((row, i) => ({
      docId: row.docId,
      stored: (row.stored ?? {}) as Record<string, unknown>,
      slotText: String((row as Record<string, unknown>)[slot] ?? ""),
      rankPos: i,
    }));
    // found_approximate when the native window was filled: the true AND set may
    // extend past the <=K OR-ranked window (header §6 + risk note in spec §8).
    const found_approximate = rows.length >= K;
    return { candidates, searchedSlot: slot, indexName, found_approximate };
  }
  ```
  Add `import type { SlotMap } from "./slotMap";` at the top of `searchRead.ts` if not already present.
  Run: `npx vitest run src/component/searchRead.test.ts`
  Expected: synthScore + reverifyAnd PASS; `runEmptyQFilterQuery` still FAIL (search.ts not yet wired).

- [ ] **Step 8:** Rewrite the `search.ts` handler to use the new read core for the two branches this task owns: (a) `tokens.length > 0` -> `runTextQuery` + `reverifyAnd` + 1-based paging + highlight; (b) `tokens.length === 0 && hasFilter` -> `runEmptyQFilterQuery`. Keep ALL empty-q browse/sort/facet branches and the envelope. Replace the imports block and the text/filter sections:

  Replace the head imports in `/Users/newuser/convex_component/src/component/search.ts` to add (do NOT remove envelope/aggregate imports still used by browse branches):
  ```ts
  import { resolveEqFilters, resolveRankProfile, runTextQuery, runEmptyQFilterQuery, reverifyAnd, synthScore, clampK, type Candidate } from "./searchRead";
  import { assignSlots } from "./slotMap";
  ```

  Inside `handler`, after `const collection = await requireCollection(...)` and the page/perPage/out_of/tokens computation, before the existing filter resolution, establish the slotMap (F9 belt-and-suspenders) and build the candidate set for the two new branches. Replace the old text path (`if (tokens.length > 0) { const m = await matchTokens(...) ...}`) and the old `else if (filterDocKeys)` filter-only path with:
  ```ts
  const slotMap = collection.slotMap ?? assignSlots(collection);
  const window = Math.min(MAX_RERANK_WINDOW, Math.max(perPage, DEFAULT_RERANK_WINDOW));

  let candidates: Candidate[] = [];
  let queryTokens: string[] = tokens;
  let searchedSlot = "text0";
  let found_approximate = false;

  if (tokens.length > 0) {
    // TEXT PATH (native OR retrieval -> app-side AND re-verify).
    const { eq, postFilter } = hasFilter
      ? resolveEqFilters(args.filterBy as string, slotMap)
      : { eq: [], postFilter: null };
    const tq = await runTextQuery(
      ctx,
      { name: args.collection, slotMap, searchFields: collection.searchFields },
      { q: args.q, queryBy: args.queryBy },
      slotMap,
      eq,
      window,
    );
    searchedSlot = tq.searchedSlot;
    let cands = tq.candidates;
    if (postFilter) cands = cands.filter((c) => postFilter(c.stored)); // ranges over <=K
    cands = reverifyAnd(cands, tokens);                                // OR -> AND
    candidates = cands;
    // honest flag (header §6): if the native window was full, the true AND set
    // may exceed K, so found is a floor.
    found_approximate = tq.found_approximate;
  } else if (hasFilter) {
    // EMPTY-Q + FILTER (F8): by_collection_doc scan + eq/postFilter, bounded take.
    const { eq, postFilter } = resolveEqFilters(args.filterBy as string, slotMap);
    candidates = await runEmptyQFilterQuery(ctx, args.collection, eq, postFilter, clampK(window));
    queryTokens = [];
  }
  ```

  Then compute `found`, ordering, facets, paging, and hits from `candidates` (Task 9 finalizes ordering+facets; for THIS task wire a minimal-but-correct path so the F8 test passes). Replace the tail that builds `found`/`pageIds`/`hits` with:
  ```ts
  const total = candidates.length;
  const found = total;
  const pageStart = (page - 1) * perPage;
  // default order: native rank (rankPos asc) for text, scan order for filter.
  const ordered = [...candidates].sort((a, b) => a.rankPos - b.rankPos);
  const pageCands = ordered.slice(pageStart, pageStart + perPage);
  const fields = args.queryBy ?? collection.searchFields;
  const matchTermSet = new Set(queryTokens);
  const hits: Hit[] = pageCands.map((c) => {
    const highlight: Record<string, { snippet: string; matched_tokens: string[] }> = {};
    if (matchTermSet.size > 0) {
      for (const field of fields) {
        const value = c.stored[field];
        if (typeof value !== "string") continue;
        const h = highlightField(value, matchTermSet);
        if (h) highlight[field] = h;
      }
    }
    return { id: c.docId, score: synthScore(c.rankPos, total), highlight };
  });
  return { found, found_approximate, reranked: true, page, out_of, hits, facet_counts: [] };
  ```
  (Task 9 replaces the ordering/found/facet portion; this minimal tail keeps the handler compiling and the F8 test green.)
  Run: `npx vitest run src/component/searchRead.test.ts -t runEmptyQFilterQuery`
  Expected: PASS.

- [ ] **Step 9:** Add a 1-based paging-math unit test (F4) to `searchRead.test.ts` and confirm the empty-q+filter run respects it:
  ```ts
  describe("1-based paging (F4)", () => {
    const pageStart = (page: number, perPage: number) => (Math.max(1, Math.floor(page)) - 1) * perPage;
    it("page 1 starts at 0; page 2 starts at perPage", () => {
      expect(pageStart(1, 10)).toBe(0);
      expect(pageStart(2, 10)).toBe(10);
      expect(pageStart(0, 10)).toBe(0); // clamps to page 1
    });
  });
  ```
  Run: `npx vitest run src/component/searchRead.test.ts`
  Expected: PASS (all blocks).

- [ ] **Step 10:** Run the full vitest suite for the touched files to confirm no regression in the pure read pieces. (Native text retrieval and OR->AND-over-1024 behavior are NOT here — they are the Task-10 smoke task via `npx convex run`.)
  Run: `npx vitest run src/component/searchRead.test.ts src/component/search.test.ts`
  Expected: searchRead.test.ts PASS. Note: `search.test.ts` text-query assertions that rely on native OR retrieval will be re-validated in the smoke task; convex-test cannot reproduce `.searchIndex` semantics (header NOTE). Update or skip those specific assertions per the Task-7 parity plan; the empty-q+filter and pure-logic specs must pass.

- [ ] **Step 11:** Commit.
  ```
  git add -A && git commit -m "feat: native runTextQuery + empty-q filter path on searchDocs slot pool

Wire search.ts retrieval onto withSearchIndex(...).take(K) with K=clamp(window,1,1024),
app-side reverifyAnd (OR->AND), 1-based paging (F4), one shared Candidate type (F2)
and one synthScore (F3). Empty-q+filter uses by_collection_doc + in-memory eq/postFilter
bounded by take (F8). Native retrieval asserted in the smoke task, not convex-test.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 9: Ranking, `found`, and facet counts over `Candidate[]` (F2/F5/F6)

This task finalizes ordering, `found`, and `facet_counts` on top of the `Candidate[]` produced by Task 8. Ranking uses the existing DSL (`evalTerms` with `synthScore` as the relevance input) when a rank profile resolves, else `orderingScore` + `compareMatches`. `found`/`out_of` follow F6 (out_of = `collectionCount`; query found = reverified count, `found_approximate` if it may exceed K). Facets follow F5: query-present -> `tallyFacets` over the `<=K` window with `facets_scoped: true`; empty-q browse/declared -> `readFacetCounts` over the kept `facetCounts` TABLE. All pure pieces are vitest-tested.

**Files:**
- Modify: `/Users/newuser/convex_component/src/component/searchRead.ts` (add `orderCandidates`, `tallyFacets`, `resolveFoundAndFacets`)
- Modify: `/Users/newuser/convex_component/src/component/search.ts` (replace the minimal tail from Task 8 with the real ordering/found/facet wiring)
- Modify: `/Users/newuser/convex_component/src/component/schema.ts` (add optional `facets_scoped` to `searchResultValidator` ONLY IF the parity plan requires surfacing it; otherwise carry it via `found_approximate`/internal — see Step 6 note)
- Test: `/Users/newuser/convex_component/src/component/searchRead.test.ts` (extend with ordering, tally, found/flag specs)

**Interfaces:**

Consumes (exact signatures):
- Task 8 `searchRead.ts`: `type Candidate = { docId; stored; slotText; rankPos }`; `synthScore(rankPos, total)`.
- Task 7 `searchRead.ts`: `resolveRankProfile(collection, rank): { profile: RankProfile; weights?: Record<string,number>; context?: RankContext } | undefined`.
- Kept `score.ts`: `evalTerms(stored, terms: RankTerm[], weights: Record<string,number>|undefined, textMatch: number, context: RankContext): number`; `type RankContext`.
- Kept `ranking.ts`: `orderingScore(textMatch: number, stored, rankBy: RankBy|undefined): number`; `compareMatches(a: string, b: string, { score, stored, sortBy }): number`; `type RankBy`, `type SortKey`.
- Kept `facetCounts.ts`: `readFacetCounts(ctx, collection, field, maxValues): Promise<{value:string;count:number}[]>` (over the `facetCounts` TABLE, bounded by `FACET_VALUE_READ_BUDGET=200`).
- Kept `counters.ts`: `collectionCount(ctx, collection): Promise<number>`.
- Schema (Task 1/2): `RankProfile = { base: string; window?: number; terms: RankTerm[] }`.

Produces (final search output; no later task consumes new symbols from this task except the smoke task):
- `function orderCandidates(candidates: Candidate[], opts: { rank?: { profile: RankProfile; weights?: Record<string,number>; context?: RankContext }; rankBy?: RankBy; sortBy?: SortKey[] }): Candidate[]`.
- `function tallyFacets(candidates: Candidate[], fields: string[], maxValues: number): FacetCount[]`.
- `async function resolveFoundAndFacets(ctx, collection, candidates, opts): Promise<{ found: number; facet_counts: FacetCount[]; facets_scoped: boolean }>`.

**Steps:**

- [ ] **Step 1:** Write the failing ordering test. Append to `/Users/newuser/convex_component/src/component/searchRead.test.ts`:
  ```ts
  import { orderCandidates, tallyFacets } from "./searchRead";

  const c = (docId: string, rankPos: number, stored: Record<string, unknown> = {}): Candidate => ({
    docId, rankPos, stored, slotText: "",
  });

  describe("orderCandidates", () => {
    it("no rank/rankBy/sortBy -> relevance via synthScore (native rank asc)", () => {
      const cands = [c("a", 2), c("b", 0), c("c", 1)];
      const out = orderCandidates(cands, {});
      expect(out.map((x) => x.docId)).toEqual(["b", "c", "a"]);
    });

    it("rank profile uses evalTerms(stored, terms, weights, synthScore(rankPos,total), context)", () => {
      const cands = [
        c("a", 0, { boost: 1 }),
        c("b", 1, { boost: 100 }),
      ];
      const out = orderCandidates(cands, {
        rank: {
          profile: { base: "default", terms: [{ id: "f", type: "field", weight: 1, field: "boost" }] },
        },
      });
      // b's field contribution (100) dominates a's (1) despite worse rank.
      expect(out.map((x) => x.docId)).toEqual(["b", "a"]);
    });

    it("sortBy on a stored numeric field overrides relevance", () => {
      const cands = [c("a", 0, { price: 30 }), c("b", 1, { price: 10 })];
      const out = orderCandidates(cands, { sortBy: [{ field: "price", order: "asc" }] });
      expect(out.map((x) => x.docId)).toEqual(["b", "a"]);
    });
  });
  ```
  Run: `npx vitest run src/component/searchRead.test.ts -t orderCandidates`
  Expected: FAIL (`orderCandidates` not implemented).

- [ ] **Step 2:** Implement `orderCandidates` in `searchRead.ts`. Rank profile path: `evalTerms(stored, profile.terms, weights, synthScore(rankPos,total), context)`. Else: `orderingScore` + `compareMatches` (relevance = `synthScore`):
  ```ts
  import { evalTerms, type RankContext } from "./score";
  import { orderingScore, compareMatches, type RankBy, type SortKey } from "./ranking";
  import type { RankProfile } from "./schema";

  export function orderCandidates(
    candidates: Candidate[],
    opts: {
      rank?: { profile: RankProfile; weights?: Record<string, number>; context?: RankContext };
      rankBy?: RankBy;
      sortBy?: SortKey[];
    },
  ): Candidate[] {
    const total = candidates.length;
    const out = [...candidates];
    if (opts.rank) {
      const { profile, weights, context } = opts.rank;
      const ctx = context ?? {};
      const baseIdx = new Map(out.map((cnd, i) => [cnd.docId, i])); // native-rank tiebreak
      const score = (cnd: Candidate) =>
        evalTerms(cnd.stored, profile.terms, weights, synthScore(cnd.rankPos, total), ctx);
      out.sort((a, b) => score(b) - score(a) || (baseIdx.get(a.docId)! - baseIdx.get(b.docId)!));
      return out;
    }
    // Relevance / rankBy / sortBy path via the kept comparator.
    const storedOf = (id: string) => out.find((x) => x.docId === id)!.stored;
    const relevance = (id: string) => {
      const cnd = out.find((x) => x.docId === id)!;
      return orderingScore(synthScore(cnd.rankPos, total), cnd.stored, opts.rankBy);
    };
    out.sort((a, b) =>
      compareMatches(a.docId, b.docId, { score: relevance, stored: storedOf, sortBy: opts.sortBy }),
    );
    return out;
  }
  ```
  Run: `npx vitest run src/component/searchRead.test.ts -t orderCandidates`
  Expected: PASS.

- [ ] **Step 3:** Write the failing `tallyFacets` test (query-scoped facet tally over the `<=K` window). Append:
  ```ts
  describe("tallyFacets (query-scoped, F5)", () => {
    it("counts stored field values over the candidate window, count desc then value asc, capped at maxValues", () => {
      const cands = [
        c("a", 0, { brand: "acme" }),
        c("b", 1, { brand: "acme" }),
        c("c", 2, { brand: "zeta" }),
        c("d", 3, { brand: "mid" }),
        c("e", 4, {}), // missing -> skipped
      ];
      const fc = tallyFacets(cands, ["brand"], 2);
      expect(fc).toEqual([
        { field_name: "brand", counts: [
          { value: "acme", count: 2 },
          { value: "mid", count: 1 },
        ] },
      ]);
    });
  });
  ```
  Run: `npx vitest run src/component/searchRead.test.ts -t tallyFacets`
  Expected: FAIL (`tallyFacets` not implemented).

- [ ] **Step 4:** Implement `tallyFacets` in `searchRead.ts` (same ordering as the kept `readFacetCounts`: count desc, value asc; missing/null skipped):
  ```ts
  import type { FacetCount } from "./types";

  export function tallyFacets(
    candidates: Candidate[],
    fields: string[],
    maxValues: number,
  ): FacetCount[] {
    const out: FacetCount[] = [];
    for (const field of fields) {
      const tally = new Map<string, number>();
      for (const cnd of candidates) {
        const raw = cnd.stored[field];
        if (raw === undefined || raw === null) continue;
        const value = String(raw);
        tally.set(value, (tally.get(value) ?? 0) + 1);
      }
      const counts = [...tally.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .slice(0, Math.max(0, maxValues))
        .map(([value, count]) => ({ value, count }));
      out.push({ field_name: field, counts });
    }
    return out;
  }
  ```
  Run: `npx vitest run src/component/searchRead.test.ts -t tallyFacets`
  Expected: PASS.

- [ ] **Step 5:** Write the failing `resolveFoundAndFacets` test (F5/F6 routing + `facets_scoped` flag). Append:
  ```ts
  describe("resolveFoundAndFacets routing (F5/F6)", () => {
    it("queryPresent -> tallyFacets over candidates with facets_scoped=true; found=candidate count", async () => {
      const t = convexTest(schema, modules);
      registerAggregate(t, "docCount");
      registerAggregate(t, "sortIndex");
      await t.mutation(api.collections.createCollection, {
        name: "qf",
        searchFields: ["name"],
        facetFields: ["brand"],
      });
      const { resolveFoundAndFacets } = await import("./searchRead");
      await t.run(async (ctx: any) => {
        const cands: Candidate[] = [
          { docId: "a", rankPos: 0, slotText: "", stored: { brand: "acme" } },
          { docId: "b", rankPos: 1, slotText: "", stored: { brand: "acme" } },
        ];
        const r = await resolveFoundAndFacets(ctx, "qf", cands, {
          queryPresent: true,
          facetFields: ["brand"],
          declaredFacets: new Set(["brand"]),
          maxFacetValues: 10,
          foundApproximate: false,
        });
        expect(r.found).toBe(2);
        expect(r.facets_scoped).toBe(true);
        expect(r.facet_counts).toEqual([
          { field_name: "brand", counts: [{ value: "acme", count: 2 }] },
        ]);
      });
    });

    it("empty-q browse -> readFacetCounts over the facetCounts TABLE; facets_scoped=false", async () => {
      const t = convexTest(schema, modules);
      registerAggregate(t, "docCount");
      registerAggregate(t, "sortIndex");
      await t.mutation(api.collections.createCollection, {
        name: "bf",
        searchFields: ["name"],
        facetFields: ["brand"],
      });
      await t.mutation(api.write.upsertMany, {
        collection: "bf",
        docs: [
          { id: "a", doc: { name: "x", brand: "acme" } },
          { id: "b", doc: { name: "y", brand: "acme" } },
          { id: "c", doc: { name: "z", brand: "zeta" } },
        ],
      });
      const { resolveFoundAndFacets } = await import("./searchRead");
      await t.run(async (ctx: any) => {
        const r = await resolveFoundAndFacets(ctx, "bf", [], {
          queryPresent: false,
          facetFields: ["brand"],
          declaredFacets: new Set(["brand"]),
          maxFacetValues: 10,
          foundApproximate: false,
          browseOutOf: 3,
        });
        expect(r.facets_scoped).toBe(false);
        expect(r.facet_counts[0].counts).toEqual([
          { value: "acme", count: 2 },
          { value: "zeta", count: 1 },
        ]);
        expect(r.found).toBe(3);
      });
    });
  });
  ```
  Run: `npx vitest run src/component/searchRead.test.ts -t resolveFoundAndFacets`
  Expected: FAIL (`resolveFoundAndFacets` not implemented).

- [ ] **Step 6:** Implement `resolveFoundAndFacets` in `searchRead.ts` (F5/F6). Query-present -> tally over candidates + `facets_scoped: true`; empty-q -> `readFacetCounts` over the table + `facets_scoped: false`. `found`: query -> reverified candidate count; browse -> `browseOutOf`. Throws on undeclared facet fields (parity with the existing handler):
  ```ts
  import { readFacetCounts } from "./facetCounts";

  export async function resolveFoundAndFacets(
    ctx: QueryCtx,
    collection: string,
    candidates: Candidate[],
    opts: {
      queryPresent: boolean;
      facetFields: string[];
      declaredFacets: Set<string>;
      maxFacetValues: number;
      foundApproximate: boolean;
      browseOutOf?: number;
    },
  ): Promise<{ found: number; facet_counts: FacetCount[]; facets_scoped: boolean }> {
    for (const field of opts.facetFields) {
      if (!opts.declaredFacets.has(field)) {
        throw new Error(`Field "${field}" is not a declared facet field`);
      }
    }
    if (opts.queryPresent) {
      const facet_counts = tallyFacets(candidates, opts.facetFields, opts.maxFacetValues);
      // found = reverified candidate count; found_approximate already carries the
      // ">K" caveat (F6). facets are over the relevance-biased <=K window -> scoped.
      return { found: candidates.length, facet_counts, facets_scoped: opts.facetFields.length > 0 };
    }
    // Empty-q browse/declared facets: counts from the facetCounts TABLE (F5),
    // bounded by FACET_VALUE_READ_BUDGET (field cardinality, not collection size).
    const facet_counts: FacetCount[] = [];
    for (const field of opts.facetFields) {
      facet_counts.push({
        field_name: field,
        counts: await readFacetCounts(ctx, collection, field, opts.maxFacetValues),
      });
    }
    return { found: opts.browseOutOf ?? candidates.length, facet_counts, facets_scoped: false };
  }
  ```
  Note on `facets_scoped`: surface it via the envelope ONLY if the parity plan keeps it in `searchResultValidator`. The header says the public envelope MUST stay unchanged, so DO NOT add a field unless Task 7 already widened the validator. If the validator is unchanged, fold the scoped signal into `found_approximate` (set `found_approximate ||= facets_scoped` when facets were tallied over a full `<=K` window) and keep `facets_scoped` internal to this function for tests. Pick the path Task 7 established; do not invent a new envelope field here.
  Run: `npx vitest run src/component/searchRead.test.ts -t resolveFoundAndFacets`
  Expected: PASS.

- [ ] **Step 7:** Replace the minimal tail in `search.ts` (from Task 8 Step 8) with the real ordering/found/facet wiring. After `candidates`/`queryTokens`/`found_approximate` are built, replace the `const total = candidates.length; ...` block through the `return` with:
  ```ts
  const rankResolved = resolveRankProfile(collection, args.rank); // may throw on bad profile/weights (F7)
  const ordered = orderCandidates(candidates, {
    rank: rankResolved,
    rankBy: args.rankBy,
    sortBy: args.sortBy,
  });
  const total = ordered.length;

  const declared = new Set(collection.facetFields ?? []);
  const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
  const ff = await resolveFoundAndFacets(ctx, args.collection, ordered, {
    queryPresent: tokens.length > 0,
    facetFields: hasFacets ? (args.facetBy as string[]) : [],
    declaredFacets: declared,
    maxFacetValues: maxValues,
    foundApproximate: found_approximate,
    browseOutOf: out_of,
  });
  const found = ff.found;          // F6: reverified candidate count (resolveFoundAndFacets) when q present
  let foundApprox = found_approximate; // true when the native OR window was full (count is a floor)
  // (Cross-check #9: do NOT reassign found = ordered.length here — orderCandidates
  // does not drop rows, so ordered.length === ff.found already; the reassignment
  // was a no-op. found_approximate already carries the "may exceed K" signal.)
  // If facets were tallied over the relevance-biased <=K window, signal it via
  // the envelope per the Task-7 decision (see resolveFoundAndFacets note).
  if (ff.facets_scoped) foundApprox = true;

  const pageStart = (page - 1) * perPage;
  const pageCands = ordered.slice(pageStart, pageStart + perPage);
  const fields = args.queryBy ?? collection.searchFields;
  const matchTermSet = new Set(queryTokens);
  const hits: Hit[] = pageCands.map((cnd) => {
    const highlight: Record<string, { snippet: string; matched_tokens: string[] }> = {};
    if (matchTermSet.size > 0) {
      for (const field of fields) {
        const value = cnd.stored[field];
        if (typeof value !== "string") continue;
        const h = highlightField(value, matchTermSet);
        if (h) highlight[field] = h;
      }
    }
    return { id: cnd.docId, score: synthScore(cnd.rankPos, total), highlight };
  });
  return {
    found,
    found_approximate: foundApprox,
    reranked: true,
    page,
    out_of,
    hits,
    facet_counts: ff.facet_counts,
  };
  ```
  Add `import { orderCandidates, tallyFacets, resolveFoundAndFacets } from "./searchRead";` to the existing `searchRead` import in `search.ts`.
  Run: `npx vitest run src/component/searchRead.test.ts`
  Expected: PASS (all blocks).

- [ ] **Step 8:** Run the facet/rank/sort parity suites to confirm the empty-q + filter-driven branches still pass under convex-test (text-query specs depending on native OR retrieval are validated by the Task-10 smoke task, per header NOTE):
  Run: `npx vitest run src/component/searchRead.test.ts src/component/facet-search.test.ts src/component/rank-search.test.ts src/component/sort-search.test.ts`
  Expected: searchRead + the empty-q/browse/sort/declared-facet assertions PASS. Mark or adjust any spec that asserts native-OR text retrieval output per the Task-7 parity ports; do not expect byte-identical scores (synthScore replaces the old 3/2/2-0.5d formula — F3).

- [ ] **Step 9:** Commit.
  ```
  git add -A && git commit -m "feat: rank/found/facets over shared Candidate[] (F2/F5/F6)

orderCandidates: evalTerms(stored,profile.terms,weights,synthScore(rankPos,total),context)
when a rank profile resolves, else orderingScore+compareMatches. resolveFoundAndFacets:
query-present tallies facets over the <=K window (scoped) and reports reverified found;
empty-q browse reads the facetCounts TABLE (bounded by FACET_VALUE_READ_BUDGET) and
out_of from the docCount aggregate. found_approximate carries the ">K"/scoped caveat.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```


### Task 10: Port batched self-scheduling `deleteCollection` to the single `searchDocs` table

After the rebuild, the only index table is `searchDocs` (the old 8+ index tables are gone). `deleteCollection` must still delete in bounded batches via `ctx.scheduler.runAfter(0, ...)` — never `.collect()`-then-delete (§6a item 1). The per-doc fan-out is gone, so the batch loop deletes only `searchDocs` rows, then clears the three aggregate/table sources of "many": `clearCollectionCount` (docCount aggregate), `clearCollectionSort` (sortIndex aggregate), and `clearCollectionFacets` (the `facetCounts` TABLE per F5 — NOT an aggregate).

**Files:**
- Modify: `/Users/newuser/convex_component/src/component/collections.ts`
  - Rewrite `deleteCollectionRowsBatch` to delete only `searchDocs` rows (drop all postingChunks/docTerms/documents/docKeyCounters/terms/trigrams/filterPostings/facetCounts/facetPostings batch deletes).
  - Rewrite `hasCollectionIndexRows` to probe only `searchDocs`.
  - Add `clearCollectionFacets` call to `cleanupCollectionBatchInternal`.
- Test: `/Users/newuser/convex_component/src/component/delete-collection.test.ts` (new)

**Interfaces:**
- Consumes (kept, exact signatures — do NOT change):
  - `clearCollectionCount(ctx: MutationCtx, collection: string): Promise<void>` (`counters.ts`)
  - `clearCollectionSort(ctx: MutationCtx, collection: string, sortSpecs: SortKey[][]): Promise<void>` (`sortIndex.ts`)
  - `clearCollectionFacets(ctx: MutationCtx, collection: string): Promise<void>` (`facetCounts.ts`, TABLE-backed)
  - `searchDocs` table (Task 1) with `.index("by_collection_doc", ["collection","docId"])`
- Consumes (constants already in `collections.ts`): `DELETE_BATCH_SIZE = 25`, `DELETE_BATCHES_PER_PUBLIC_CALL = 64`
- Produces (for later tasks / parity): unchanged public `deleteCollection` mutation + `cleanupCollectionBatch` internalMutation signatures; new internal helper `deleteCollectionRowsBatch(ctx, name, batchSize): Promise<boolean>` (returns `true` when no rows remained this batch).

**Steps:**

- [ ] **Step 1:** Add the import for `clearCollectionFacets` at the top of `collections.ts`. Find the line `import { clearCollectionCount } from "./counters";` and add immediately after it:
```ts
import { clearCollectionFacets } from "./facetCounts";
```

- [ ] **Step 2:** Write the failing test. Create `/Users/newuser/convex_component/src/component/delete-collection.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

// DELETE_BATCH_SIZE=25, DELETE_BATCHES_PER_PUBLIC_CALL=64 -> one public call
// clears up to 25*64=1600 rows. Seed > one batch (60) so we exercise the loop,
// and assert the searchDocs table is empty afterward.
async function setup() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  registerAggregate(t, "sortIndex");
  await t.mutation(api.collections.createCollection, {
    name: "products",
    searchFields: ["name"],
    storedFields: ["name"],
    facetFields: ["name"],
  });
  return t;
}

async function searchDocCount(t: any): Promise<number> {
  return await t.run(async (ctx: any) => {
    const rows = await ctx.db
      .query("searchDocs")
      .withIndex("by_collection_doc", (q: any) => q.eq("collection", "products"))
      .collect();
    return rows.length;
  });
}

describe("deleteCollection (single searchDocs table)", () => {
  it("removes every searchDocs row across multiple batches via self-scheduling", async () => {
    const t = await setup();
    const docs = Array.from({ length: 60 }, (_, i) => ({
      id: `p${i}`,
      doc: { name: `shoe ${i}` },
    }));
    for (const d of docs) {
      await t.mutation(api.write.upsert, { collection: "products", id: d.id, doc: d.doc });
    }
    expect(await searchDocCount(t)).toBe(60);

    await t.mutation(api.collections.deleteCollection, { name: "products" });
    await t.finishAllScheduledFunctions(() => {});

    expect(await searchDocCount(t)).toBe(0);
    const col = await t.query(api.collections.getCollection, { name: "products" });
    expect(col).toBeNull();
  });

  it("clears the facetCounts table for the collection", async () => {
    const t = await setup();
    for (let i = 0; i < 30; i++) {
      await t.mutation(api.write.upsert, { collection: "products", id: `p${i}`, doc: { name: "shoe" } });
    }
    await t.mutation(api.collections.deleteCollection, { name: "products" });
    await t.finishAllScheduledFunctions(() => {});
    const facetRows = await t.run(async (ctx: any) =>
      ctx.db
        .query("facetCounts")
        .withIndex("by_field", (q: any) => q.eq("collection", "products"))
        .collect(),
    );
    expect(facetRows.length).toBe(0);
  });
});
```

- [ ] **Step 3:** Run the test, expect FAIL (old `deleteCollectionRowsBatch` still queries dropped tables; it will throw on the missing `documents`/`postingChunks` indexes, or leave `searchDocs` rows undeleted):
```
npx vitest run src/component/delete-collection.test.ts
```
Expected: FAIL.

- [ ] **Step 4:** Replace `hasCollectionIndexRows` in `collections.ts` so it probes only `searchDocs`:
```ts
async function hasCollectionIndexRows(ctx: QueryCtx, name: string): Promise<boolean> {
  const row = await ctx.db
    .query("searchDocs")
    .withIndex("by_collection_doc", (q) => q.eq("collection", name))
    .first();
  return !!row;
}
```

- [ ] **Step 5:** Replace `deleteCollectionRowsBatch` in `collections.ts` so it deletes only `searchDocs` rows in a bounded `.take(batchSize)` window (returns `true` only when the batch found nothing left):
```ts
async function deleteCollectionRowsBatch(
  ctx: MutationCtx,
  name: string,
  batchSize: number,
): Promise<boolean> {
  const rows = await ctx.db
    .query("searchDocs")
    .withIndex("by_collection_doc", (q) => q.eq("collection", name))
    .take(batchSize);
  if (rows.length > 0) {
    for (const r of rows) await ctx.db.delete(r._id);
    return false;
  }
  return true;
}
```

- [ ] **Step 6:** Add the facet-table clear to `cleanupCollectionBatchInternal` in `collections.ts`. Replace the existing body's clear section:
```ts
async function cleanupCollectionBatchInternal(
  ctx: MutationCtx,
  name: string,
  sortSpecs: SortKey[][],
  batchSize: number,
): Promise<{ done: boolean }> {
  const done = await deleteCollectionRowsBatch(ctx, name, batchSize);
  if (!done) return { done: false };

  await clearCollectionCount(ctx, name);
  await clearCollectionSort(ctx, name, sortSpecs);
  await clearCollectionFacets(ctx, name);
  const deletion = await loadDeletion(ctx, name);
  if (deletion) await ctx.db.delete(deletion._id);
  return { done: true };
}
```
Note: the public `deleteCollection` handler and `cleanupCollectionBatch` internalMutation (the synchronous `DELETE_BATCHES_PER_PUBLIC_CALL` loop + `ctx.scheduler.runAfter(0, internal.collections.cleanupCollectionBatch, ...)` tail) stay exactly as-is — only the per-batch row deletion and the clear set changed. `clearCollectionFacets` is bounded by field cardinality (per F5), not collection size.

- [ ] **Step 7:** Run the test, expect PASS:
```
npx vitest run src/component/delete-collection.test.ts
```
Expected: PASS (both `it` blocks). The 60-doc delete completes after self-scheduled batches drained via `finishAllScheduledFunctions`, `searchDocs` count is 0, the collection row is gone, and `facetCounts` is cleared.

- [ ] **Step 8:** Commit:
```
git add src/component/collections.ts src/component/delete-collection.test.ts
git commit -m "Task 10: port batched deleteCollection to single searchDocs table

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Replace fixed-50 `upsertMany` batching with a write-bounded, scheduler-chained bound; document app-paged reindex

Per §6a item 3, hybrid `upsert` writes only ~1 `searchDocs` row + a few aggregate/facet ops per doc (vs ~30-150 before), so the limit is on *row writes*, not a magic doc count. Replace the hard `MAX_UPSERT_MANY_BATCH = 50` cap with a bound derived from row-writes: each doc costs `WRITES_PER_DOC` (1 searchDocs row + bounded facet/sort ops). If a call's docs would approach the per-mutation write ceiling, process a bounded prefix and self-schedule the remainder via `ctx.scheduler.runAfter`. Reindex/backfill stays app-paged: the component never reads the app corpus (it processes one `upsert` at a time); the `example/convex/products.ts` `reindex` driver paginates the app's own `productDocs` ~100/page and self-chains — document this, do not change component read behavior.

**Files:**
- Modify: `/Users/newuser/convex_component/src/component/write.ts`
  - Remove `export const MAX_UPSERT_MANY_BATCH = 50;` and the throw.
  - Add `const WRITES_PER_DOC` and `const UPSERT_MANY_MAX_WRITES` constants; derive `UPSERT_MANY_BATCH` from them.
  - Add an `upsertManyChain` internalMutation that processes a bounded slice and self-schedules the rest.
  - Rewrite `upsertMany` to process the first bounded slice inline, then schedule the remainder.
- Test: `/Users/newuser/convex_component/src/component/upsert-many.test.ts` (new)

**Interfaces:**
- Consumes (from Task 3/4, per F9 — slotMap must already exist before any upsert):
  - `applyCollectionConfig` mutation (`configSync.ts`) which assigns + persists `slotMap` via `assignSlots`. Tests create the collection through `api.configSync.applyCollectionConfig` so `slotMap` is present (F9 invariant: "create/apply must precede upsert").
  - `projectToSlots(doc, col)` (Task 3, `searchWrite.ts`) used by `upsertInternal` to build the `searchDocs` row.
  - `upsertInternal(ctx: MutationCtx, collection: string, id: string, doc: Doc): Promise<void>` (kept name in `write.ts`).
- Consumes (Convex): `internal.write.upsertManyChain` (new self-schedule target).
- Produces (for later tasks): `upsertMany` mutation (unchanged public args `{ collection, docs: {id, doc}[] }`, returns `v.null()`) now accepting batches larger than 50; new `upsertManyChain` internalMutation; `UPSERT_MANY_BATCH` constant other modules may import.

**Steps:**

- [ ] **Step 1:** Write the failing test. Create `/Users/newuser/convex_component/src/component/upsert-many.test.ts`. It creates the collection via `applyCollectionConfig` (F9: slotMap exists) and registers BOTH aggregates (F1):
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
  registerAggregate(t, "sortIndex");
  // Per F9: applyCollectionConfig assigns + persists slotMap via assignSlots,
  // so an upsert can never run without a slotMap.
  await t.mutation(api.configSync.applyCollectionConfig, {
    config: {
      name: "products",
      searchFields: ["name"],
      storedFields: ["name"],
    },
  });
  return t;
}

async function searchDocCount(t: any): Promise<number> {
  return await t.run(async (ctx: any) => {
    const rows = await ctx.db
      .query("searchDocs")
      .withIndex("by_collection_doc", (q: any) => q.eq("collection", "products"))
      .collect();
    return rows.length;
  });
}

describe("upsertMany (write-bounded, scheduler-chained)", () => {
  it("writes one searchDocs row per doc for a batch larger than the old fixed-50 cap", async () => {
    const t = await setup();
    const N = 120; // > old MAX_UPSERT_MANY_BATCH (50)
    const docs = Array.from({ length: N }, (_, i) => ({
      id: `p${i}`,
      doc: { name: `shoe ${i}` },
    }));
    await t.mutation(api.write.upsertMany, { collection: "products", docs });
    // Drain any self-scheduled continuation chain.
    await t.finishAllScheduledFunctions(() => {});
    expect(await searchDocCount(t)).toBe(N);
  });

  it("accepts > 50 docs without throwing", async () => {
    const t = await setup();
    const docs = Array.from({ length: 51 }, (_, i) => ({
      id: `q${i}`,
      doc: { name: "shoe" },
    }));
    await expect(
      t.mutation(api.write.upsertMany, { collection: "products", docs }),
    ).resolves.toBeNull();
  });
});
```

- [ ] **Step 2:** Run the test, expect FAIL (current `upsertMany` throws on `docs.length > 50`):
```
npx vitest run src/component/upsert-many.test.ts
```
Expected: FAIL with `upsertMany accepts at most 50 documents per call`.

- [ ] **Step 3:** In `write.ts`, replace the fixed-50 constant with write-bounded constants. Replace this line:
```ts
export const MAX_UPSERT_MANY_BATCH = 50;
```
with:
```ts
// Per spec §6a: the bound is on ROW WRITES, not a magic doc count. Hybrid upsert
// writes ~1 searchDocs row + a few aggregate/facet ops per doc. Keep a generous
// per-slice write budget under the per-mutation write limit; chain the remainder.
const WRITES_PER_DOC = 12; // 1 searchDocs row + bounded facet/sort/aggregate ops headroom
const UPSERT_MANY_MAX_WRITES = 3000;
export const UPSERT_MANY_BATCH = Math.max(1, Math.floor(UPSERT_MANY_MAX_WRITES / WRITES_PER_DOC));
```

- [ ] **Step 4:** Import `internal` in `write.ts` (for the self-schedule target). At the top of `write.ts`, find `import { mutation } from "./_generated/server";` and replace with:
```ts
import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
```

- [ ] **Step 5:** Replace the `upsertMany` mutation in `write.ts` with a slice-and-chain version, and add the `upsertManyChain` internalMutation right after it:
```ts
export const upsertMany = mutation({
  args: {
    collection: v.string(),
    docs: v.array(v.object({ id: v.string(), doc: v.any() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collection);
    const slice = args.docs.slice(0, UPSERT_MANY_BATCH);
    for (const { id, doc } of slice) {
      await upsertInternal(ctx, args.collection, id, doc as Doc);
    }
    const rest = args.docs.slice(UPSERT_MANY_BATCH);
    if (rest.length > 0) {
      await ctx.scheduler.runAfter(0, internal.write.upsertManyChain, {
        collection: args.collection,
        docs: rest,
      });
    }
    return null;
  },
});

export const upsertManyChain = internalMutation({
  args: {
    collection: v.string(),
    docs: v.array(v.object({ id: v.string(), doc: v.any() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collection);
    const slice = args.docs.slice(0, UPSERT_MANY_BATCH);
    for (const { id, doc } of slice) {
      await upsertInternal(ctx, args.collection, id, doc as Doc);
    }
    const rest = args.docs.slice(UPSERT_MANY_BATCH);
    if (rest.length > 0) {
      await ctx.scheduler.runAfter(0, internal.write.upsertManyChain, {
        collection: args.collection,
        docs: rest,
      });
    }
    return null;
  },
});
```
Note: `upsertInternal` already builds the `searchDocs` row via `projectToSlots` (Task 3) and requires `col.slotMap` (F9). With `UPSERT_MANY_BATCH = 250`, the 120-doc and 51-doc tests run in one slice (no chain), but the chain path remains exercised by `finishAllScheduledFunctions` when a future caller exceeds the slice.

- [ ] **Step 6:** Reindex/backfill stays APP-PAGED — document it, do NOT change component reads. The component never reads the app corpus; `example/convex/products.ts::reindex` paginates the app-owned `productDocs` table and self-chains via `ctx.scheduler.runAfter(0, api.products.reindex, { cursor: page.continueCursor, batch })`, calling `search.upsertMany` per page and `search.clearPending` when `page.isDone`. Hybrid lowers per-doc write cost (~1 `searchDocs` row vs ~30-150), so the default page size can rise to `MAX_COMPONENT_BATCH` (50). In `example/convex/products.ts::reindex`, change the EXACT current line (verified at ~line 357):
```ts
    const size = Math.min(batch ?? 10, MAX_COMPONENT_BATCH);   // old: default 10
```
to:
```ts
    // Hybrid upsert writes ~1 searchDocs row + a few aggregate ops per doc, so the
    // default page rises to MAX_COMPONENT_BATCH. PAGE SOURCE is the app's own
    // productDocs table — the component never reads the app corpus.
    const size = Math.min(batch ?? MAX_COMPONENT_BATCH, MAX_COMPONENT_BATCH);
```
(`MAX_COMPONENT_BATCH = 50` is unchanged; the page size stays ≤ 50. Leave the `paginate`/`upsertMany`/`clearPending` self-chain structure unchanged.)

- [ ] **Step 7:** Run the test, expect PASS:
```
npx vitest run src/component/upsert-many.test.ts
```
Expected: PASS (both `it` blocks): 120 docs -> 120 `searchDocs` rows; 51 docs resolves without throwing.

- [ ] **Step 8:** Regression-check the existing write suite still passes (no module imports the removed `MAX_UPSERT_MANY_BATCH`):
```
npx vitest run src/component/write.test.ts src/component/upsert-many.test.ts src/component/delete-collection.test.ts
```
Expected: PASS. If any file imports `MAX_UPSERT_MANY_BATCH`, update it to `UPSERT_MANY_BATCH` (grep first: `grep -rn MAX_UPSERT_MANY_BATCH src example`).

- [ ] **Step 9:** Commit:
```
git add src/component/write.ts src/component/upsert-many.test.ts example/convex/products.ts
git commit -m "Task 11: write-bounded scheduler-chained upsertMany; app-paged reindex

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```


### Task 12: Real-deployment smoke test (native-search behavior — NOT vitest)

> `convex-test` simulates the backend and does NOT reproduce native `.searchIndex` behavior (OR-by-relevance, the 1024 cap, sync-at-commit indexing). The semantic + scale guarantees in spec §7.2 therefore cannot be asserted in vitest. This task verifies them against a **real Convex deployment** via `npx convex run`, exercising the public `FuzzySearch` client surface end to end. There is no vitest file for this task; the "test" is a small set of example Convex functions plus copy-pasteable `npx convex run` commands with expected output.

**Files:**
- Create: `example/convex/smoke.ts` (internal mutations/queries that drive the `FuzzySearch` client for smoke verification)
- Modify: none (client `src/client/index.ts` is consumed read-only)
- Test: none (vitest); verification is via `npx convex run` against a deployed example app

**Interfaces:**
- Consumes (from `src/client/index.ts`, already present — Step 0 verifies):
  - `new FuzzySearch(component, { collections? })`
  - `search.sync(ctx): Promise<{ name; kind; pendingFields }[]>`
  - `search.createCollection(ctx, { name; searchFields; storedFields?; filterFields?; facetFields?; sortSpecs?; rankProfiles? }): Promise<...>`
  - `search.getCollection(ctx, name)`
  - `search.upsert(ctx, { collection; id; doc }): Promise<...>`
  - `search.upsertMany(ctx, { collection; docs: { id; doc }[] }): Promise<...>`
  - `search.search(ctx, { collection; q; page?; perPage?; queryBy?; filterBy?; facetBy?; maxFacetValues?; rankBy?; sortBy?; rank? }): Promise<SearchResult>`
  - `search.deleteCollection(ctx, name)`
  - `search.stats(ctx, collection): Promise<{ out_of; facets; sortSpecs }>`
  - `SearchResult` shape: `{ found; found_approximate; reranked; page; out_of; hits; facet_counts }` (from `searchResultValidator`)
- Produces (for later tasks): nothing consumed by code; produces the manual sign-off that native search behaves per spec §7.2 (same-txn searchability, bounded page, no throw on common terms, batched deleteCollection drains).

**Steps:**

- [ ] **Step 0:** Verify the client methods this task drives actually exist before writing any example code. Run:
  ```
  grep -nE "async (sync|createCollection|getCollection|upsert|upsertMany|search|deleteCollection|stats)\b" src/client/index.ts
  ```
  Expected output — eight matching lines (one per method): `sync`, `createCollection`, `getCollection`, `upsert`, `upsertMany`, `search`, `deleteCollection`, `stats`. If any method is missing, STOP and fix the client first; the smoke functions below depend on all eight.

- [ ] **Step 1:** Create `example/convex/smoke.ts` with the driver functions. These wrap the `FuzzySearch` client so they can be invoked with `npx convex run`. Real code (no placeholders):
  ```ts
  import { internalMutation, internalQuery } from "./_generated/server";
  import { components } from "./_generated/api";
  import { v } from "convex/values";
  import { FuzzySearch } from "@convex-dev/fuzzy-search";

  const search = new FuzzySearch(components.fuzzySearch);
  const COLLECTION = "smoke";

  // Recreate the collection fresh so the smoke run is idempotent.
  export const reset = internalMutation({
    args: {},
    handler: async (ctx) => {
      const existing = await search.getCollection(ctx, COLLECTION);
      if (existing) await search.deleteCollection(ctx, COLLECTION);
      await search.createCollection(ctx, {
        name: COLLECTION,
        searchFields: ["title", "body"],
        storedFields: "all",
        filterFields: [{ field: "brand", type: "string" }, { field: "price", type: "number" }],
        facetFields: ["brand"],
      });
      return { ok: true };
    },
  });

  // Upsert one doc, then in the SAME transaction search for it: native
  // .searchIndex is synchronous at commit, so it must already be findable.
  export const sameTxnSearchable = internalMutation({
    args: { id: v.string(), title: v.string() },
    handler: async (ctx, { id, title }) => {
      await search.upsert(ctx, { collection: COLLECTION, id, doc: { title, body: "smoke body", brand: "Acme", price: 10 } });
      const r = await search.search(ctx, { collection: COLLECTION, q: title, perPage: 5 });
      const found = r.hits.some((h) => h.id === id);
      return { found, hitIds: r.hits.map((h) => h.id) };
    },
  });

  // Seed N docs that all share a common term, to exercise the bounded page +
  // no-throw guarantee on a high-frequency query.
  export const seedCommon = internalMutation({
    args: { n: v.number(), term: v.string() },
    handler: async (ctx, { n, term }) => {
      const BATCH = 200;
      for (let start = 0; start < n; start += BATCH) {
        const docs = Array.from({ length: Math.min(BATCH, n - start) }, (_, i) => {
          const k = start + i;
          return { id: `c${String(k).padStart(7, "0")}`, doc: { title: `${term} item ${k}`, body: "x", brand: k % 2 ? "Acme" : "Globex", price: k } };
        });
        await search.upsertMany(ctx, { collection: COLLECTION, docs });
      }
      return { seeded: n };
    },
  });

  export const commonSearch = internalQuery({
    args: { term: v.string(), perPage: v.optional(v.number()) },
    handler: async (ctx, { term, perPage }) => {
      const r = await search.search(ctx, { collection: COLLECTION, q: term, perPage: perPage ?? 25 });
      return { found: r.found, found_approximate: r.found_approximate, out_of: r.out_of, page: r.page, hitCount: r.hits.length };
    },
  });

  export const collectionStats = internalQuery({
    args: {},
    handler: async (ctx) => search.stats(ctx, COLLECTION),
  });
  ```

- [ ] **Step 2:** Deploy the example app so the new functions and the rebuilt component schema (nine `searchIndex`es) are live. Run from the repo root:
  ```
  npx convex dev --once --component-dir ./src/component
  ```
  Then deploy the example functions:
  ```
  cd example && npx convex deploy --yes
  ```
  Expected: deploy succeeds and prints the nine search indexes `s0..s8` being created on `searchDocs` (first deploy). FAIL signal: a schema error about more than 16 search indexes, or an unknown `searchDocs` table — go back and fix the schema task.

- [ ] **Step 3 (reset + same-transaction searchability):** Run:
  ```
  npx convex run smoke:reset
  npx convex run smoke:sameTxnSearchable '{"id":"smoke-1","title":"zephyrine"}'
  ```
  Expected: `{ "found": true, "hitIds": ["smoke-1", ...] }`. This proves native sync-at-commit (a doc inserted in this txn is searchable in the same txn). FAIL signal: `found:false` — native indexing assumption is wrong; STOP.

- [ ] **Step 4 (bounded page on a common term, no throw):** Seed a collection larger than the 1024 native cap and the perPage cap, then query the common term:
  ```
  npx convex run smoke:seedCommon '{"n":3000,"term":"widget"}'
  npx convex run smoke:commonSearch '{"term":"widget","perPage":25}'
  ```
  Expected: a JSON object that returns without throwing, with `hitCount` ≤ 25 (bounded by perPage), `out_of` ≥ 3000 (from the docCount aggregate, O(log n)), and `found_approximate: true` (the true match set may exceed the K≤1024 native window, so the AND-reverify count is flagged approximate). FAIL signal: the call THROWS ("read set too large" / native 1024 cap exceeded) — the read path is not clamping `.take(K≤1024)`; STOP and fix searchRead.

- [ ] **Step 5 (filter + facet under the common term, no throw):** Run a filtered, faceted version of the common-term search:
  ```
  npx convex run smoke:commonSearch '{"term":"widget","perPage":10}'
  npx convex run smoke:collectionStats
  ```
  Expected: `commonSearch` returns `hitCount` ≤ 10 without throwing; `collectionStats` returns `out_of` ≥ 3000 and a `facets` entry for `brand` with a `total` that does not require scanning the collection (bounded facetCounts table read). FAIL signal: a throw or an `out_of` of 0.

- [ ] **Step 6 (deleteCollection drains via self-scheduling):** Trigger batched deletion and confirm it drains without exceeding per-call limits:
  ```
  npx convex run smoke:reset
  ```
  (`reset` calls `deleteCollection` then recreates.) Then immediately verify the prior collection's rows are being drained by the scheduler — poll `collectionStats`:
  ```
  npx convex run smoke:collectionStats
  ```
  Expected: `reset` returns `{ ok: true }` without throwing (the public `deleteCollection` call processes `DELETE_BATCH_SIZE`(25) × `DELETE_BATCHES_PER_PUBLIC_CALL`(64) rows then self-schedules `cleanupCollectionBatch` via `ctx.scheduler.runAfter(0, ...)`), and a subsequent `collectionStats` shows `out_of` for the freshly recreated empty collection is 0. FAIL signal: `reset` throws a write-limit / read-limit error — deletion is not batched/self-scheduling; STOP and port the batched-deletion pattern.

- [ ] **Step 7:** Record the smoke results inline in `example/convex/smoke.ts` as a top-of-file comment block (the exact commands run + the observed `found/found_approximate/out_of/hitCount` numbers), so the manual sign-off is reproducible. Then commit:
  ```
  git add example/convex/smoke.ts
  git commit -m "$(cat <<'EOF'
  test: real-deployment smoke for native hybrid search (same-txn searchability, bounded page, batched deleteCollection)

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 13: Drop the dead hand-rolled index tables + modules

> The hybrid rebuild (Tasks 1–11) moved all retrieval onto `searchDocs` + native `.searchIndex` and onto the kept `facetCounts`/aggregate/`sortIndex` layers. The legacy inverted-index tables and their modules are now unreferenced on the hot path. This task removes them from `schema.ts` and deletes the orphaned modules, gated by a typecheck that proves nothing imports them. Spec §7.4: "No hand-rolled index tables remain."
>
> **⚠️ CRITICAL ORDERING (cross-check fixes #1/#4/#5):** Three kept files still touch the legacy tables/modules after Tasks 1–11 and MUST be migrated in **Step 0 of this task**, before any deletion, or the `tsc` gate fails:
> 1. **`search.ts` browse/sort/rank-browse branches** still read the `documents` table (via `loadDocs`) and the `terms` table (the `singleExactTerm` `found` correction), and still import `matchTokens`/`loadDocumentByDocKey`/`resolveAstToDocIds`/`readFacetPostingDocKeys`. Tasks 8–9 only migrated the q>0 and empty-q+filter branches. **All remaining branches must read `stored` from `searchDocs` via `by_collection_doc`** (add a `loadStored(ctx, collection, docId)` helper, or reuse the empty-q path's bounded read), and the `terms` `found` correction is dropped (F6: `found` = reverified candidate count / aggregate count).
> 2. **`filter.ts`** imports `{ readStringPostingDocKeys, readNumericRangeDocKeys }` from `./filterPostings` and uses them in `resolveAstToDocIds`. Strip `resolveAstToDocIds` + its helpers (`strKeys`/`numEqKeys`/`numCmpKeys`/`numRangeKeys`/`keysResult`/`ResolveResult`) and the import; `filter.ts` must export ONLY `parseFilterAst`, `astToPredicate`, `parseFilter`, `Ast`, `Predicate`, `FieldType` (the symbols `resolveEqFilters` consumes).
> 3. **`stats.ts`** queries the `facetPostings` and `filterPostings` TABLES and `statsResultValidator` advertises those arrays. Remove both query blocks + return fields from `stats.ts` and both array fields from `statsResultValidator` in `schema.ts`. (`statsResultValidator` is NOT part of the frozen envelope, so this is allowed.) Update `example/convex/products.ts::indexStats` and any client consumer of those fields.

**Files:**
- Modify FIRST (Step 0 migrations): `src/component/search.ts` (browse/sort/rank branches → `searchDocs.stored`; drop legacy imports), `src/component/filter.ts` (prune `resolveAstToDocIds` + `filterPostings` import), `src/component/stats.ts` + `statsResultValidator` in `schema.ts` (drop `filterPostings`/`facetPostings` health arrays), `example/convex/products.ts` (`indexStats` consumer)
- Modify: `src/component/schema.ts` (remove `documents`, `docKeyCounters`, `docTerms`, `postingChunks`, `terms`, `trigrams`, `filterPostings`, `facetPostings` table defs)
- Delete: `src/component/postingChunks.ts`, `src/component/terms.ts`, `src/component/filterPostings.ts`, `src/component/facetPostings.ts`, `src/component/matching.ts`, `src/component/docKeys.ts`, `src/component/textSearch.ts`
- Delete (their now-orphaned unit tests): `src/component/postingCompression.test.ts`, `src/component/terms.test.ts`, `src/component/filterPostings.test.ts`, `src/component/facetPostings.test.ts`, `src/component/matching.test.ts`, `src/component/filter-resolve.test.ts`, `src/component/facets-write.test.ts`, `src/component/filters-write.test.ts`, `src/component/facetCounts.test.ts` only if `facetCounts.ts` is being removed (it is NOT — `facetCounts` table + module are KEPT per F5, so DO NOT delete `facetCounts.ts`/`facetCounts.test.ts`)
- Test: `tsc --noEmit` (the gate); existing ported suites from Task 14 must still pass

**Interfaces:**
- Consumes (from Tasks 1–11, must already be true before this task runs):
  - `searchDocs` table live in `schema.ts` with `by_collection_doc` + `s0..s8` (search read/write no longer touch legacy tables)
  - `searchRead.ts` / `searchWrite.ts` are the only retrieval paths; `search.ts` rewritten to call them (no `matchTokens`/`loadDocumentByDocKey`/`resolveAstToDocIds`-over-filterPostings imports remain)
  - KEPT modules unchanged: `tokenizer.ts`, `ranking.ts`, `score.ts`, `highlight.ts`, `storedFields.ts`, `sortIndex.ts`, `counters.ts`, `collections.ts`, `configSync.ts`, `facetCounts.ts`, `filter.ts` (its AST `parseFilterAst`/`astToPredicate` are reused by `resolveEqFilters`)
- Produces (for later tasks): a `schema.ts` whose only tables are `collections`, `deletions`, `searchDocs`, `facetCounts`; no legacy modules on disk.

**Steps:**

- [ ] **Step 0 (PRE-DELETION MIGRATION — do this first; the deletion below depends on it):** Migrate the three kept files that still touch legacy tables/modules (see the ⚠️ ordering note above).
  - **0a — `search.ts` browse/sort/rank branches:** add a bounded stored-loader and reroute every branch that still reads the `documents` table:
    ```ts
    // src/component/searchRead.ts (add): load a doc's stored projection from searchDocs.
    export async function loadStored(
      ctx: QueryCtx, collection: string, docId: string,
    ): Promise<Record<string, unknown>> {
      const row = await ctx.db
        .query("searchDocs")
        .withIndex("by_collection_doc", (q) => q.eq("collection", collection).eq("docId", docId))
        .unique();
      return (row?.stored ?? {}) as Record<string, unknown>;
    }
    ```
    In `search.ts`: replace the `loadDocs(...)` helper body (which queried `documents`) with `Promise.all(ids.map((id) => loadStored(ctx, collection, id)))`-style reads of `searchDocs`; delete the `singleExactTerm`→`terms` `found` correction block entirely (F6: `found` comes from the reverified candidate count / `collectionCount` aggregate); remove the now-dead imports `matchTokens` (`./textSearch`), `loadDocumentByDocKey`/`loadDocumentByDocId` (`./docKeys`), `resolveAstToDocIds` (`./filter`), `readFacetPostingDocKeys` (`./facetPostings`). Keep `parseFilterAst` only if a branch still needs it (the resolvers in Task 7 own filter parsing now).
  - **0b — `filter.ts` prune:** delete `resolveAstToDocIds` and its helpers `strKeys`/`numEqKeys`/`numCmpKeys`/`numRangeKeys`/`keysResult`, the `ResolveResult` type, and the `import { readStringPostingDocKeys, readNumericRangeDocKeys } from "./filterPostings"` line. The file must export ONLY `parseFilterAst`, `astToPredicate`, `parseFilter`, `Ast`, `Predicate`, `FieldType`.
  - **0c — `stats.ts` + `statsResultValidator`:** remove the `facetPostings` and `filterPostings` query blocks and their return fields from `stats.ts`, and delete the `facetPostings`/`filterPostings` array fields from `statsResultValidator` in `schema.ts`. Update `example/convex/products.ts::indexStats` (and any client consumer) to stop reading those fields.
  - Gate 0: `npx tsc --noEmit` — expect remaining errors ONLY about the legacy *tables* still existing (those are removed in Step 2), NOT about `search.ts`/`filter.ts`/`stats.ts` importing dropped *modules*. Confirm `grep -nE "matchTokens|resolveAstToDocIds|readFacetPostingDocKeys|loadDocumentByDoc" src/component/search.ts` returns nothing.

- [ ] **Step 1 (prove the modules are dead — failing-state check):** List which non-test, non-self files still import each doomed module. Run:
  ```
  grep -rnE "from \"\\./(postingChunks|terms|textSearch|filterPostings|facetPostings|matching|docKeys)\"" src --include=*.ts | grep -v ".test.ts" | grep -vE "(postingChunks|terms|textSearch|filterPostings|facetPostings|matching|docKeys)\.ts:"
  ```
  Expected after Step 0: ZERO lines. If any line appears, STOP — that caller was missed in Step 0; migrate it to `searchRead`/`searchWrite`/`facetCounts` before deletion. (`filter.ts` keeping `parseFilterAst`/`astToPredicate` is fine — it must NOT import `filterPostings`.)

- [ ] **Step 2:** Remove the eight legacy table definitions from `src/component/schema.ts`. Delete the `documents`, `docKeyCounters`, `docTerms`, `postingChunks`, `terms`, `trigrams`, `filterPostings`, `facetPostings` blocks (lines ~154–246 in the pre-rebuild file). Leave `collections`, `deletions`, `searchDocs` (added in Task 1/3), and `facetCounts` (KEPT). After the edit, `defineSchema({...})` contains exactly: `collections`, `deletions`, `searchDocs`, `facetCounts`. Also confirm the envelope validators (`searchResultValidator`, `hitValidator`, `facetCountValidator`) are untouched. (`statsResultValidator`'s `filterPostings`/`facetPostings` arrays were already removed in Step 0c — verify they are gone.)

- [ ] **Step 3:** Delete the orphaned modules and their unit tests:
  ```
  git rm src/component/postingChunks.ts src/component/terms.ts src/component/textSearch.ts src/component/filterPostings.ts src/component/facetPostings.ts src/component/matching.ts src/component/docKeys.ts
  git rm src/component/postingCompression.test.ts src/component/terms.test.ts src/component/textSearch.test.ts src/component/filterPostings.test.ts src/component/facetPostings.test.ts src/component/matching.test.ts src/component/filter-resolve.test.ts src/component/facets-write.test.ts src/component/filters-write.test.ts
  ```
  Do NOT remove `facetCounts.ts` / `facetCounts.test.ts` (KEPT per F5). Do NOT remove `filter.ts` / `filter.test.ts` (AST kept per F7).

- [ ] **Step 4 (typecheck gate — the pass condition):** Run:
  ```
  npm run build:codegen
  npx tsc --noEmit
  ```
  Expected: PASS with zero errors. FAIL signal: `Cannot find name 'documents'` / `Property 'postingChunks' does not exist` — a caller still references a removed table or module; fix the caller (route it to `searchDocs`/`searchRead`/`facetCounts`), do NOT re-add the table.

- [ ] **Step 5 (no-orphan-import sweep):** Confirm no source file imports any deleted module and the deleted files are gone:
  ```
  grep -rnE "(postingChunks|textSearch|filterPostings|facetPostings|matching|docKeys)" src --include=*.ts ; ls src/component/postingChunks.ts 2>&1
  ```
  Expected: no grep matches in remaining files (a stray match inside `filter.ts` for the word "matching" in a comment is acceptable, but no `import` lines), and `ls` prints `No such file or directory`.

- [ ] **Step 6:** Run the full vitest suite to confirm the surviving tests still pass after the schema/table removal:
  ```
  npx vitest run
  ```
  Expected: PASS (the legacy unit tests are gone; the ported behavior suites from Task 14 and all kept unit tests pass). FAIL signal: a kept test imports a removed module — that test belonged to a removed module and should have been deleted in Step 3.

- [ ] **Step 7:** Commit.
  ```
  git add -A
  git commit -m "$(cat <<'EOF'
  refactor: drop hand-rolled inverted-index tables and modules

  Remove documents/docKeyCounters/docTerms/postingChunks/terms/trigrams/
  filterPostings/facetPostings from schema.ts and delete the orphaned
  modules now that searchDocs + native searchIndex + kept facetCounts/
  aggregate layers own all retrieval. Typecheck + full vitest gate green.

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 14: Port the existing behavior suites as the parity gate (assert the known deltas)

> Spec §7.1: the existing suites are ported and pass **with the known semantic deltas asserted explicitly**, not byte-identical. This task rewrites each behavior suite against the rebuilt `search.ts` (which calls `searchRead`), changing exactly the assertions affected by: OR→AND re-verify, synthesized score (F3), the 1-based paging convention (F4), query-scoped vs table facets (F5), `found`/`found_approximate` sourcing (F6), and range-filter-via-postFilter (F7/F8). Every ported file uses the F1 setup convention (both aggregates registered).

**Files:**
- Modify (port in place): `src/component/search.test.ts`, `src/component/facet-search.test.ts`, `src/component/rank-search.test.ts`, `src/component/sort-search.test.ts`, `src/component/filter.test.ts`
- Test: the five files above are the gate
- Note: `src/component/filter-resolve.test.ts`, `filters-write.test.ts`, `facets-write.test.ts` were deleted in Task 13 (they tested removed modules); their behavioral intent is re-covered here through the public `search` query.

**Interfaces:**
- Consumes (from earlier tasks):
  - `synthScore(rankPos: number, total: number): number = total <= 0 ? 0 : (total - rankPos) / total` (F3, defined once in `searchRead.ts`, imported by tests for expectation math)
  - `type Candidate = { docId: string; stored: Record<string, unknown>; slotText: string; rankPos: number }` (F2)
  - `resolveEqFilters(filterBy: string, slotMap: SlotMap): { eq: { slot: string; value: string | number }[]; postFilter: Predicate | null }` (F7)
  - `resolveRankProfile(collection, rank): { profile: RankProfile; weights?; context? } | undefined` (F7)
  - public `api.search.search` query (returns `searchResultValidator` shape, unchanged envelope)
  - public `api.write.upsert` / `api.write.upsertMany` / `api.collections.createCollection`
  - aggregate test registration: `registerAggregate(t, "docCount")` and `registerAggregate(t, "sortIndex")` (F1)
- Produces (for later tasks): the green parity gate proving the public envelope + ranking/facet/sort/filter behavior survives the rebuild with documented deltas.

**Known assertion deltas (what changes, and how — apply these as you port):**
- **D1 multi-word AND:** native is OR; the page is still strict-AND after `reverifyAnd`. Keep `found` / hit-id assertions for queries whose full match set is ≤ K. For a multi-word query whose AND set could exceed K, add `expect(r.found_approximate).toBe(true)` (was implicitly exact).
- **D2 score:** old `text_match` was `exact=3/prefix=2/typo=2−0.5d`. New `hit.score` = `synthScore(rankPos, total)`. Replace any `expect(hit.score).toBe(3)`-style assertions with monotonicity checks: top hit `score === synthScore(0, n)` and scores are non-increasing down the page (`expect(r.hits[i].score).toBeGreaterThanOrEqual(r.hits[i+1].score)`).
- **D3 paging:** assertions pass `page: 1` for the first page (1-based, F4); `pageStart = (page-1)*perPage`.
- **D4 facets:** with `q` present, facet counts are tallied over the ≤K candidate window and `facets_scoped`/`found_approximate` may be set — assert `facets_scoped`/approx flags rather than exact whole-collection counts. With empty `q`, facet counts come from the `facetCounts` TABLE (`readFacetCounts`) and stay exact — keep those assertions.
- **D5 found:** `out_of === collectionCount` (docCount aggregate) — keep. For a query, `found === reverified candidate count`; assert `found_approximate` true when that count could exceed K.
- **D6 range filter:** an equality clause becomes native `.eq` on `filtN`/`numFN`; a RANGE (`price:>100`, `price:[100..200]`) becomes an in-memory `postFilter` over the ≤K window (F7/F8). Keep the result-correctness assertion; for a range that could narrow beyond K, assert `found_approximate`.
- **D7 empty-q + filter:** runs over `by_collection_doc` (scoped) with eq+postFilter in a bounded `take()` window (F8), deterministic under convex-test — keep exact filter-result assertions.

**Steps:**

- [ ] **Step 1 (search.test.ts — single + multi token, score, paging):** Rewrite the suite to the F1 setup (both aggregates) and the deltas above. Real test bodies:
  ```ts
  import { describe, it, expect } from "vitest";
  import { convexTest } from "convex-test";
  import { register as registerAggregate } from "@convex-dev/aggregate/test";
  import schema from "./schema";
  import { api } from "./_generated/api";
  import { synthScore } from "./searchRead";

  const modules = import.meta.glob("./**/*.ts");

  async function setup() {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");
    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name", "description"],
      storedFields: "all",
    });
    await t.mutation(api.write.upsertMany, {
      collection: "products",
      docs: [
        { id: "p1", doc: { name: "Red Running Shoe", description: "for runners" } },
        { id: "p2", doc: { name: "Blue Running Jacket", description: "rain proof" } },
        { id: "p3", doc: { name: "Red Hat", description: "wool" } },
      ],
    });
    return t;
  }

  describe("search (hybrid native)", () => {
    it("single token returns all matches, out_of from aggregate", async () => {
      const t = await setup();
      const r = await t.query(api.search.search, { collection: "products", q: "red", page: 1 });
      expect(r.found).toBe(2);
      expect(r.out_of).toBe(3); // collectionCount aggregate (F6)
      expect(r.hits.map((h: any) => h.id).sort()).toEqual(["p1", "p3"]);
    });

    it("multi token is strict AND after reverify (delta D1)", async () => {
      const t = await setup();
      const r = await t.query(api.search.search, { collection: "products", q: "red running", page: 1 });
      expect(r.found).toBe(1); // only p1 has BOTH "red" and "running"
      expect(r.hits[0].id).toBe("p1");
    });

    it("score is synthesized from native rank position (delta D2)", async () => {
      const t = await setup();
      const r = await t.query(api.search.search, { collection: "products", q: "red", page: 1 });
      const n = r.hits.length;
      expect(r.hits[0].score).toBeCloseTo(synthScore(0, n), 6); // rank 0 -> highest
      for (let i = 0; i < r.hits.length - 1; i++) {
        expect(r.hits[i].score).toBeGreaterThanOrEqual(r.hits[i + 1].score); // non-increasing
      }
    });

    it("1-based paging slices (page-1)*perPage (delta D3)", async () => {
      const t = convexTest(schema, modules);
      registerAggregate(t, "docCount");
      registerAggregate(t, "sortIndex");
      await t.mutation(api.collections.createCollection, { name: "big", searchFields: ["name"], storedFields: "all" });
      const docs = Array.from({ length: 30 }, (_, i) => ({ id: `d${String(i).padStart(3, "0")}`, doc: { name: `widget ${i}` } }));
      await t.mutation(api.write.upsertMany, { collection: "big", docs });
      const p1 = await t.query(api.search.search, { collection: "big", q: "widget", page: 1, perPage: 10 });
      const p2 = await t.query(api.search.search, { collection: "big", q: "widget", page: 2, perPage: 10 });
      expect(p1.page).toBe(1);
      expect(p2.page).toBe(2);
      expect(p1.hits.length).toBe(10);
      const overlap = p1.hits.map((h: any) => h.id).filter((id: string) => p2.hits.some((h: any) => h.id === id));
      expect(overlap).toEqual([]); // disjoint pages
    });
  });
  ```
  Run (will FAIL before `searchRead`/`search.ts` are wired, PASS after Tasks 1–11):
  ```
  npx vitest run src/component/search.test.ts
  ```
  Expected: PASS.

- [ ] **Step 2 (facet-search.test.ts — table facets for empty-q, scoped tally for query, deltas D4/D5):** Port to assert both facet sources:
  ```ts
  import { describe, it, expect } from "vitest";
  import { convexTest } from "convex-test";
  import { register as registerAggregate } from "@convex-dev/aggregate/test";
  import schema from "./schema";
  import { api } from "./_generated/api";

  const modules = import.meta.glob("./**/*.ts");

  async function seeded() {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");
    await t.mutation(api.collections.createCollection, {
      name: "cat",
      searchFields: ["name"],
      storedFields: "all",
      facetFields: ["brand"],
    });
    await t.mutation(api.write.upsertMany, {
      collection: "cat",
      docs: [
        { id: "a", doc: { name: "red widget", brand: "Acme" } },
        { id: "b", doc: { name: "red gadget", brand: "Acme" } },
        { id: "c", doc: { name: "blue widget", brand: "Globex" } },
      ],
    });
    return t;
  }

  describe("facet counts (hybrid)", () => {
    it("empty-q facets come from the facetCounts table and are exact (D4)", async () => {
      const t = await seeded();
      const r = await t.query(api.search.search, { collection: "cat", q: "", facetBy: ["brand"], page: 1 });
      const counts = r.facet_counts.find((f: any) => f.field_name === "brand")!.counts;
      expect(counts.find((c: any) => c.value === "Acme")!.count).toBe(2);
      expect(counts.find((c: any) => c.value === "Globex")!.count).toBe(1);
    });

    it("query-scoped facets tally over the candidate window (D4)", async () => {
      const t = await seeded();
      const r = await t.query(api.search.search, { collection: "cat", q: "red", facetBy: ["brand"], page: 1 });
      const counts = r.facet_counts.find((f: any) => f.field_name === "brand")!.counts;
      // only "red" docs (a,b) tallied -> Acme:2, no Globex
      expect(counts.find((c: any) => c.value === "Acme")!.count).toBe(2);
      expect(counts.find((c: any) => c.value === "Globex")).toBeUndefined();
    });

    it("undeclared facet field throws", async () => {
      const t = await seeded();
      await expect(
        t.query(api.search.search, { collection: "cat", q: "", facetBy: ["nope"], page: 1 }),
      ).rejects.toThrow(/not a declared facet field/);
    });
  });
  ```
  Run:
  ```
  npx vitest run src/component/facet-search.test.ts
  ```
  Expected: PASS.

- [ ] **Step 3 (rank-search.test.ts — profile via resolveRankProfile, evalTerms over synthScore, delta D2):** Port the existing `feed` profile seed (kept from the current file) and assert ordering by the DSL, with the relevance term fed by `synthScore`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { convexTest } from "convex-test";
  import { register as registerAggregate } from "@convex-dev/aggregate/test";
  import schema from "./schema";
  import { api } from "./_generated/api";

  const modules = import.meta.glob("./**/*.ts");

  async function seeded() {
    const c = convexTest(schema, modules);
    registerAggregate(c, "docCount");
    registerAggregate(c, "sortIndex");
    await c.mutation(api.collections.createCollection, {
      name: "jobs",
      searchFields: ["title"],
      storedFields: "all",
      facetFields: ["category"],
      sortSpecs: [[{ field: "postedAt", order: "desc" as const }]],
      rankProfiles: {
        feed: {
          base: "postedAt:desc",
          window: 10,
          terms: [
            { id: "partner", type: "flag", weight: 100, field: "partnered" },
            { id: "fresh", type: "recencyDecay", weight: 1, field: "postedAt", halfLifeMs: 8.64e7 },
            { id: "pref", type: "setBoost", weight: 50, field: "category", setKey: "prefCats" },
            { id: "rel", type: "relevance", weight: 1 },
          ],
        },
      },
    });
    const now = 1_000_000_000_000;
    const docs = [
      { id: "old-partner", doc: { id: "old-partner", title: "engineer", partnered: true,  postedAt: now - 5 * 8.64e7, category: "Eng" } },
      { id: "new-plain",   doc: { id: "new-plain",   title: "engineer", partnered: false, postedAt: now - 1 * 8.64e7, category: "Sales" } },
      { id: "old-plain",   doc: { id: "old-plain",   title: "engineer", partnered: false, postedAt: now - 9 * 8.64e7, category: "Eng" } },
    ];
    for (const d of docs) await c.mutation(api.write.upsert, { collection: "jobs", ...d });
    return { c, now };
  }

  describe("rank profile (hybrid)", () => {
    it("flag weight floats the partnered doc to the top under a text query", async () => {
      const { c, now } = await seeded();
      const r = await c.query(api.search.search, {
        collection: "jobs", q: "engineer", page: 1,
        rank: { profile: "feed", context: { now } },
      });
      expect(r.hits[0].id).toBe("old-partner"); // weight 100 flag dominates
      expect(r.reranked).toBe(true);
    });

    it("unknown profile throws (extracted resolveRankProfile)", async () => {
      const { c } = await seeded();
      await expect(
        c.query(api.search.search, { collection: "jobs", q: "engineer", rank: { profile: "ghost" } }),
      ).rejects.toThrow(/Unknown rank profile/);
    });

    it("unknown weight override throws", async () => {
      const { c } = await seeded();
      await expect(
        c.query(api.search.search, { collection: "jobs", q: "engineer", rank: { profile: "feed", weights: { bogus: 1 } } }),
      ).rejects.toThrow(/Unknown rank weight override/);
    });
  });
  ```
  Run:
  ```
  npx vitest run src/component/rank-search.test.ts
  ```
  Expected: PASS.

- [ ] **Step 4 (sort-search.test.ts — empty-q sort off the aggregate, unchanged path):** This path does not touch native search (F8 / kept aggregate sort), so assertions stay close to the original; only update setup to register both aggregates and pass `page: 1`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { convexTest } from "convex-test";
  import { register as registerAggregate } from "@convex-dev/aggregate/test";
  import schema from "./schema";
  import { api } from "./_generated/api";

  const modules = import.meta.glob("./**/*.ts");

  async function seeded() {
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    registerAggregate(t, "sortIndex");
    await t.mutation(api.collections.createCollection, {
      name: "items",
      searchFields: ["name"],
      storedFields: "all",
      sortSpecs: [[{ field: "price", order: "asc" as const }]],
    });
    await t.mutation(api.write.upsertMany, {
      collection: "items",
      docs: [
        { id: "x", doc: { name: "x", price: 30 } },
        { id: "y", doc: { name: "y", price: 10 } },
        { id: "z", doc: { name: "z", price: 20 } },
      ],
    });
    return t;
  }

  describe("sort (empty-q, aggregate path)", () => {
    it("empty q sorts by declared spec via the sortIndex aggregate", async () => {
      const t = await seeded();
      const r = await t.query(api.search.search, {
        collection: "items", q: "", page: 1,
        sortBy: [{ field: "price", order: "asc" }],
      });
      expect(r.hits.map((h: any) => h.id)).toEqual(["y", "z", "x"]); // 10,20,30
      expect(r.out_of).toBe(3);
      expect(r.found).toBe(3);
    });
  });
  ```
  Run:
  ```
  npx vitest run src/component/sort-search.test.ts
  ```
  Expected: PASS.

- [ ] **Step 5 (filter.test.ts — pure AST predicate, unchanged; add a public-search filter delta test D6/D7):** Keep the existing pure `parseFilter` unit tests (they test `filter.ts`'s AST, which is kept verbatim). Append an integration block that exercises equality-as-native-eq and range-as-postFilter through the public query:
  ```ts
  import { describe, it, expect } from "vitest";
  import { convexTest } from "convex-test";
  import { register as registerAggregate } from "@convex-dev/aggregate/test";
  import schema from "./schema";
  import { api } from "./_generated/api";
  import { parseFilter } from "./filter";

  const modules = import.meta.glob("./**/*.ts");
  const types = { brand: "string", price: "number" } as const;
  const P = (s: string) => parseFilter(s, types);

  describe("parseFilter (kept AST)", () => {
    it("exact string match", () => {
      const p = P("brand:Aurora");
      expect(p({ brand: "Aurora" })).toBe(true);
      expect(p({ brand: "Nimbus" })).toBe(false);
    });
    it("numeric range inclusive", () => {
      const p = P("price:[100..200]");
      expect(p({ price: 100 })).toBe(true);
      expect(p({ price: 250 })).toBe(false);
    });
  });

  describe("filter through public search (D6/D7)", () => {
    async function seeded() {
      const t = convexTest(schema, modules);
      registerAggregate(t, "docCount");
      registerAggregate(t, "sortIndex");
      await t.mutation(api.collections.createCollection, {
        name: "shop",
        searchFields: ["name"],
        storedFields: "all",
        filterFields: [{ field: "brand", type: "string" }, { field: "price", type: "number" }],
      });
      await t.mutation(api.write.upsertMany, {
        collection: "shop",
        docs: [
          { id: "a", doc: { name: "widget", brand: "Acme", price: 50 } },
          { id: "b", doc: { name: "widget", brand: "Acme", price: 150 } },
          { id: "c", doc: { name: "widget", brand: "Globex", price: 250 } },
        ],
      });
      return t;
    }

    it("equality filter resolves to native .eq (empty q, scoped scan) — D7", async () => {
      const t = await seeded();
      const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "brand:Acme", page: 1 });
      expect(r.hits.map((h: any) => h.id).sort()).toEqual(["a", "b"]);
      expect(r.found).toBe(2);
    });

    it("range filter resolves to in-memory postFilter over the candidate window — D6", async () => {
      const t = await seeded();
      const r = await t.query(api.search.search, { collection: "shop", q: "widget", filterBy: "price:>100", page: 1 });
      expect(r.hits.map((h: any) => h.id).sort()).toEqual(["b", "c"]); // 150, 250
    });

    it("equality AND range combines native .eq + postFilter", async () => {
      const t = await seeded();
      const r = await t.query(api.search.search, { collection: "shop", q: "widget", filterBy: "brand:Acme && price:>100", page: 1 });
      expect(r.hits.map((h: any) => h.id)).toEqual(["b"]); // Acme + >100
    });
  });
  ```
  Run:
  ```
  npx vitest run src/component/filter.test.ts
  ```
  Expected: PASS.

- [ ] **Step 6 (full parity gate):** Run the whole suite to confirm the ported behavior suites and all kept unit tests are green together:
  ```
  npx vitest run
  ```
  Expected: PASS (all files). FAIL signal: a delta assertion still encodes old semantics (e.g. `score === 3`, OR-leaked extra hits, 0-based page) — fix the assertion per D1–D7, do NOT loosen `searchRead`.

- [ ] **Step 7:** Commit.
  ```
  git add src/component/search.test.ts src/component/facet-search.test.ts src/component/rank-search.test.ts src/component/sort-search.test.ts src/component/filter.test.ts
  git commit -m "$(cat <<'EOF'
  test: port behavior suites as parity gate with explicit hybrid deltas

  OR->AND reverify (D1), synthesized score (D2/F3), 1-based paging (D3/F4),
  table facets for empty-q + scoped tally for query (D4/F5), found/out_of
  from aggregates (D5/F6), range filter via in-memory postFilter (D6/F7),
  empty-q+filter scoped scan (D7/F8). Full vitest green.

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```


