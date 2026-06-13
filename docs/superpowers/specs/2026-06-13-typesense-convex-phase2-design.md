# Phase 2 — Filtering + Faceting — Design

**Date:** 2026-06-13
**Status:** Approved (design); pending implementation plan
**Scope:** `filter_by` structured filtering + query-scoped `facet_counts`.
**Depends on:** Phase 1 + the typo/prefix search feature (search loads all collection docs per query, matching/ranking in place).

## Key revision from the original provisional spec

The provisional Phase 2 spec proposed a separate indexed `filters` table maintained on every write. **That is dropped.** Because `search` already materializes every document in the collection per query (the bounded-scale reality of the current implementation), filtering and faceting are done **in-memory over the already-loaded stored documents** — no new table, no write-path changes, identical correctness, same bounded-scale envelope. The indexed `filters` table (and arrays-as-facets) move to **Phase 4** scale hardening, when the full-collection load itself is removed. This keeps Phase 2 to: collection-config additions + a pure filter parser + search integration + faceting.

## Decisions (locked)

- **Filter syntax:** full boolean — exact, in-set, numeric comparators, numeric range, `&&`, `||`, parentheses. **Negation (`!=`) deferred.**
- **Facet source:** tally values from the stored documents already loaded by search (no extra reads).
- **`max_facet_values`:** default **10** per field, overridable per query; facet values sorted by count desc (tie-break value asc).
- **Filterable/facetable fields must be persisted** (within `storedFields`, or `storedFields: "all"`), enforced at `createCollection`.
- **No write-path or schema-table change.** Filtering/faceting are pure query-time concerns.

## Collection Config Additions

`createCollection` (and a new `updateConfig` is NOT in scope) accepts two optional arrays:

```
filterFields?: { field: string, type: "string" | "number" }[]
facetFields?:  string[]
```

Stored on the `collections` row (schema gains two optional columns). Validation at `createCollection`:
- Every `filterFields[].field` and every `facetFields` entry must be retained by `storedFields` (i.e. `storedFields === "all"`, or the field is in the `storedFields` list). Otherwise throw a clear error (the value would not be persisted, so it could not be evaluated).

## Filter Parser (pure module `filter.ts`)

`parseFilter(filterBy: string, fieldTypes: Record<string, "string"|"number">): Predicate`
where `Predicate = (stored: Record<string, unknown>) => boolean`.

**Grammar:**
```
expr    := orExpr
orExpr  := andExpr ( "||" andExpr )*
andExpr := unary ( "&&" unary )*
unary   := "(" expr ")" | clause
clause  := field ":" matcher
matcher := "[" value ( "," value )* "]"        // in-set (when no "..")
         | "[" num ".." num "]"                 // numeric range (inclusive)
         | (">" | ">=" | "<" | "<=") num        // numeric comparator
         | value                                // exact
```

**Evaluation semantics** (against a single stored doc):
- Field type comes from `fieldTypes` (the declared `filterFields`). Unknown field in a filter → parse/throw error.
- `string` field: exact and in-set compare `String(stored[field])` to the literal(s). Comparators/range on a string field → error.
- `number` field: comparators and range parse `Number(stored[field])`; exact/in-set compare numerically. A missing or non-coercible value fails the clause (false), never throws at eval time.
- `&&` → both; `||` → either; parentheses group. Whitespace around operators ignored. Values may be quoted (`brand:"Le Coq"`) to include spaces/special chars; unquoted values run to the next operator/bracket/comma.

The parser is a small recursive-descent parser + tokenizer, fully unit-testable without Convex.

## Search Integration

`search` gains two optional args:
- `filterBy?: string` — a `filter_by` expression.
- `facetBy?: string[]` — fields to facet (must be declared `facetFields`).
- `maxFacetValues?: number` — default 10.

**Pipeline (extends the current one):**
1. Compute the text-match set + scores (existing: tokens → exact/prefix/fuzzy → AND; or match-all on empty `q`).
2. If `filterBy` present: build the predicate via `parseFilter` (types from the collection's `filterFields`); keep only matched docs whose stored doc satisfies the predicate. (`search` already has every doc's `stored` in the `byId` map.)
3. The surviving set is the result set: `found` = its size; rank/sort/paginate as today; hits unchanged.
4. **Faceting:** if `facetBy` present, for each field iterate the **entire result set** (not just the page), read `stored[field]`, tally counts per stringified value; emit the top `maxFacetValues` by count (desc), tie-break value asc, as:
   ```jsonc
   "facet_counts": [
     { "field_name": "brand", "counts": [ { "value": "Aurora", "count": 2 }, ... ] }
   ]
   ```
   Faceting reflects the filtered + searched set (query-scoped), matching Typesense semantics.

Envelope otherwise unchanged. `highlight` remains `{}`.

## Error Handling

- `filterBy` referencing a field not in `filterFields` → thrown parse error with the field name.
- `facetBy` referencing a field not in `facetFields` → thrown error.
- Malformed `filterBy` (bad syntax, comparator on a string field, non-numeric range bound) → thrown parse error with a clear message.
- `createCollection` with filter/facet fields not covered by `storedFields` → thrown error.
- `maxFacetValues` clamped to `>= 0`.

## Client + Example

- Client `search` method gains `filterBy?`, `facetBy?`, `maxFacetValues?` passthrough; types exported.
- Example: declare `filterFields` (brand, category as string; price as number) and `facetFields` (brand, category) on the products collection; enable the storefront's facet sidebar (brand/category checkboxes that add `filterBy` clauses) and show live facet counts; everything else as-is.

## Known Limits (Phase 2)

- Filtering/faceting are exact only within the bounded-scale envelope (search loads all collection docs). Same ceiling as current search; no new ceiling introduced.
- Array-valued facet/filter fields (e.g. tags) are **not** supported yet (scalar string/number only) — Phase 4.
- The indexed, write-maintained `filters` table for scale is **Phase 4**.
- Negation (`!=`, not-in) deferred.

## Testing Strategy (TDD — colocated `*.test.ts`, convex-test + Vitest)

- **`parseFilter` unit (no Convex):** exact; in-set; each comparator; range; `&&`/`||`/precedence; parentheses; quoted values; unknown-field error; comparator-on-string error; malformed-syntax error; numeric coercion of stored values; missing value → clause false.
- **createCollection validation:** filter/facet field not in `storedFields` → error; happy path with `storedFields: "all"`.
- **Search + filter:** `brand:Aurora` narrows; `price:>100`; range; in-set; `&&`/`||`; filter combined with a text query (intersection); filter combined with empty-`q` browse.
- **Faceting:** counts reflect the filtered+searched set (query-scoped), not global; multiple facet fields; `maxFacetValues` cap + ordering (count desc, value asc); facet over empty result → empty counts.
- **Envelope:** `facet_counts` shape exactly matches the Typesense form; absent `facetBy` → `[]`.
- **Example smoke:** brand facet shows correct counts; clicking a brand filters results and updates counts.
