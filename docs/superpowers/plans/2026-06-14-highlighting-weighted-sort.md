# Highlighting + Weighted Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full-field-value highlighting (`<mark>` matched terms) and weighted/multi-key sorting (`rankBy` blend + `sortBy`) to search, in-memory over the docs search already loads.

**Architecture:** Two pure modules — `highlight.ts` (`highlightField(value, matchedTerms)`) and `ranking.ts` (`orderingScore` + `compareMatches`). `search` unions candidate terms into `matchedTerms`, orders results via `ranking.ts`, and builds per-hit `highlight` via `highlight.ts`. Reported `text_match` stays the raw relevance score.

**Tech Stack:** Convex (component), TypeScript (`verbatimModuleSyntax` ON — `import type`), convex-test + Vitest. Tests COLOCATED (`src/component/*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-06-14-highlighting-weighted-sort-design.md`

**Repo conventions:** colocated tests import `schema` from `./schema`, `api` from `./_generated/api`, glob `import.meta.glob("./**/*.ts")`. Run `npm run build:codegen` after schema changes (none here, but search arg changes need codegen to update `_generated`). Deployment configured.

---

## File Structure

```
src/component/highlight.ts   # NEW: pure highlightField(value, matchedTerms) -> {snippet, matched_tokens} | null
src/component/ranking.ts      # NEW: pure orderingScore() + compareMatches()
src/component/types.ts        # tighten Hit.highlight type
src/component/search.ts       # collect matchedTerms; order via ranking; build highlight
src/client/index.ts           # rankBy/sortBy passthrough
example/convex/products.ts    # searchProducts passes sortBy
example/src/*                 # sort dropdown + render highlighted name
README.md
```

---

## Task 1: `highlight.ts` — pure field highlighter

**Files:** Create `src/component/highlight.ts`; Test `src/component/highlight.test.ts`.

- [ ] **Step 1: Write failing test `src/component/highlight.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { highlightField } from "./highlight";

const terms = (...t: string[]) => new Set(t);

describe("highlightField", () => {
  it("wraps a matched word preserving original case and punctuation", () => {
    expect(highlightField("Red Running Shoe!", terms("running"))).toEqual({
      snippet: "Red <mark>Running</mark> Shoe!",
      matched_tokens: ["Running"],
    });
  });

  it("wraps multiple distinct matches and dedups matched_tokens", () => {
    expect(highlightField("run run RUN", terms("run"))).toEqual({
      snippet: "<mark>run</mark> <mark>run</mark> <mark>RUN</mark>",
      matched_tokens: ["run", "RUN"],
    });
  });

  it("returns null when nothing matches", () => {
    expect(highlightField("blue hat", terms("running"))).toBeNull();
  });

  it("escapes HTML in the field text but keeps mark tags", () => {
    expect(highlightField("a <b> run", terms("run"))).toEqual({
      snippet: "a &lt;b&gt; <mark>run</mark>",
      matched_tokens: ["run"],
    });
  });

  it("returns null for non-string or empty input", () => {
    expect(highlightField("", terms("x"))).toBeNull();
    expect(highlightField(undefined as unknown as string, terms("x"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/highlight.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/component/highlight.ts`**

```ts
// Words are runs of Unicode letters/numbers — the same alphabet the tokenizer
// splits on — but here we keep the ORIGINAL segments (case + separators).
const WORD = /[\p{L}\p{N}]+/gu;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Highlight one field value: wrap each word whose lowercased form is in
// `matchedTerms` with <mark>…</mark>. Non-mark text is HTML-escaped so the
// resulting snippet is safe to render. Returns null if nothing matched.
export function highlightField(
  value: string,
  matchedTerms: Set<string>,
): { snippet: string; matched_tokens: string[] } | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let out = "";
  let last = 0;
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const m of value.matchAll(WORD)) {
    const word = m[0];
    const start = m.index!;
    out += esc(value.slice(last, start));
    if (matchedTerms.has(word.toLowerCase())) {
      out += `<mark>${esc(word)}</mark>`;
      if (!seen.has(word)) {
        seen.add(word);
        matched.push(word);
      }
    } else {
      out += esc(word);
    }
    last = start + word.length;
  }
  out += esc(value.slice(last));
  if (matched.length === 0) return null;
  return { snippet: out, matched_tokens: matched };
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run src/component/highlight.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/component/highlight.ts src/component/highlight.test.ts
git commit -m "feat: pure field highlighter (mark matched terms, HTML-safe)"
```

---

## Task 2: `ranking.ts` — pure ordering score + comparator

**Files:** Create `src/component/ranking.ts`; Test `src/component/ranking.test.ts`.

- [ ] **Step 1: Write failing test `src/component/ranking.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { orderingScore, compareMatches } from "./ranking";
import type { RankBy, SortKey } from "./ranking";

describe("orderingScore", () => {
  it("returns text_match when no rankBy", () => {
    expect(orderingScore(3, { price: 10 }, undefined)).toBe(3);
  });
  it("blends text weight + field weights", () => {
    const rankBy: RankBy = { text: 1, fields: [{ field: "popularity", weight: 0.5 }] };
    expect(orderingScore(2, { popularity: 10 }, rankBy)).toBe(2 + 5);
  });
  it("text defaults to 1; non-numeric field coerces to 0", () => {
    const rankBy: RankBy = { fields: [{ field: "pop", weight: 2 }] };
    expect(orderingScore(3, {}, rankBy)).toBe(3);
    expect(orderingScore(3, { pop: "x" }, rankBy)).toBe(3);
  });
});

describe("compareMatches", () => {
  const stored: Record<string, Record<string, unknown>> = {
    a: { price: 30 },
    b: { price: 10 },
    c: { price: 10 },
  };
  const score: Record<string, number> = { a: 1, b: 2, c: 2 };
  const cmp = (sortBy?: SortKey[]) => (x: string, y: string) =>
    compareMatches(x, y, {
      score: (id) => score[id],
      stored: (id) => stored[id],
      sortBy,
    });

  it("defaults to score desc, docId asc tie-break", () => {
    expect(["a", "b", "c"].sort(cmp())).toEqual(["b", "c", "a"]);
  });
  it("sorts by a numeric field ascending", () => {
    expect(["a", "b", "c"].sort(cmp([{ field: "price", order: "asc" }]))).toEqual(["b", "c", "a"]);
  });
  it("multi-key: price asc then docId tie-break", () => {
    expect(["c", "b", "a"].sort(cmp([{ field: "price", order: "asc" }]))).toEqual(["b", "c", "a"]);
  });
  it("_text_match key uses the score", () => {
    expect(["a", "b", "c"].sort(cmp([{ field: "_text_match", order: "desc" }]))).toEqual(["b", "c", "a"]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/ranking.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/component/ranking.ts`**

```ts
export type RankBy = { text?: number; fields?: { field: string; weight: number }[] };
export type SortKey = { field: string; order: "asc" | "desc" };

function numField(stored: Record<string, unknown>, field: string): number {
  const v = Number(stored[field]);
  return Number.isNaN(v) ? 0 : v;
}

// The relevance score used for ordering: raw text_match, optionally blended with
// weighted numeric fields (Elasticsearch field_value_factor style).
export function orderingScore(
  textMatch: number,
  stored: Record<string, unknown>,
  rankBy: RankBy | undefined,
): number {
  if (!rankBy) return textMatch;
  let s = (rankBy.text ?? 1) * textMatch;
  for (const { field, weight } of rankBy.fields ?? []) {
    s += weight * numField(stored, field);
  }
  return s;
}

// Comparator over docIds. `_text_match` keys use the supplied ordering score;
// other keys use the stored field coerced to number. Default sort is score desc.
// Final tie-break is docId ascending for deterministic output.
export function compareMatches(
  a: string,
  b: string,
  ctx: {
    score: (id: string) => number;
    stored: (id: string) => Record<string, unknown>;
    sortBy?: SortKey[];
  },
): number {
  const keys: SortKey[] = ctx.sortBy ?? [{ field: "_text_match", order: "desc" }];
  for (const k of keys) {
    const va = k.field === "_text_match" ? ctx.score(a) : numField(ctx.stored(a), k.field);
    const vb = k.field === "_text_match" ? ctx.score(b) : numField(ctx.stored(b), k.field);
    if (va !== vb) return k.order === "asc" ? va - vb : vb - va;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run src/component/ranking.test.ts`
Expected: PASS (both describes).

- [ ] **Step 5: Commit**

```bash
git add src/component/ranking.ts src/component/ranking.test.ts
git commit -m "feat: pure ordering score (weighted blend) + multi-key comparator"
```

---

## Task 3: Search integration — matchedTerms, highlight, rankBy/sortBy ordering

**Files:** Modify `src/component/types.ts`, `src/component/search.ts`; Test `src/component/search.test.ts` (append).

- [ ] **Step 1: Tighten `Hit.highlight` in `src/component/types.ts`**

Change the `Hit` type's `highlight` field from `Record<string, unknown>` to:
```ts
  highlight: Record<string, { snippet: string; matched_tokens: string[] }>;
```
(Leave the rest of `types.ts` unchanged. An empty `{}` still satisfies this type.)

- [ ] **Step 2: Append failing tests to `src/component/search.test.ts`**

```ts
describe("highlighting + weighted sort", () => {
  async function setupShop() {
    const t = convexTest(schema, modules);
    await t.mutation(api.collections.createCollection, {
      name: "shop",
      searchFields: ["name"],
      storedFields: "all",
    });
    await t.mutation(api.write.upsertMany, {
      collection: "shop",
      docs: [
        { id: "1", doc: { name: "Red Running Shoe", price: 90, popularity: 1 } },
        { id: "2", doc: { name: "Blue Running Jacket", price: 50, popularity: 100 } },
        { id: "3", doc: { name: "Red Hat", price: 20, popularity: 5 } },
      ],
    });
    return t;
  }

  it("highlights the matched term in the field, preserving case", async () => {
    const t = await setupShop();
    const r = await t.query(api.search.search, { collection: "shop", q: "running" });
    const hit = r.hits.find((h: any) => h.document.id === "1");
    expect(hit.highlight).toEqual({
      name: { snippet: "Red <mark>Running</mark> Shoe", matched_tokens: ["Running"] },
    });
  });

  it("prefix query highlights the full term", async () => {
    const t = await setupShop();
    const r = await t.query(api.search.search, { collection: "shop", q: "run" });
    const hit = r.hits.find((h: any) => h.document.id === "1");
    expect(hit.highlight.name.snippet).toContain("<mark>Running</mark>");
  });

  it("browse mode yields empty highlight", async () => {
    const t = await setupShop();
    const r = await t.query(api.search.search, { collection: "shop", q: "" });
    expect(r.hits[0].highlight).toEqual({});
  });

  it("rankBy blends popularity to reorder (and text_match stays raw)", async () => {
    const t = await setupShop();
    // Both "Running" docs have equal raw text_match; popularity boost lifts id 2.
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "running",
      rankBy: { text: 1, fields: [{ field: "popularity", weight: 1 }] },
    });
    expect(r.hits[0].document.id).toBe("2"); // popularity 100 wins
    expect(r.hits[0].text_match).toBe(3); // reported relevance is still raw
  });

  it("sortBy price ascending orders by field", async () => {
    const t = await setupShop();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      sortBy: [{ field: "price", order: "asc" }],
    });
    expect(r.hits.map((h: any) => h.document.id)).toEqual(["3", "2", "1"]); // 20,50,90
  });

  it("sortBy price descending", async () => {
    const t = await setupShop();
    const r = await t.query(api.search.search, {
      collection: "shop",
      q: "",
      sortBy: [{ field: "price", order: "desc" }],
    });
    expect(r.hits.map((h: any) => h.document.id)).toEqual(["1", "2", "3"]); // 90,50,20
  });
});
```

- [ ] **Step 3: Update `src/component/search.ts`**

Add imports near the top (after the existing imports):
```ts
import { highlightField } from "./highlight";
import { orderingScore, compareMatches } from "./ranking";
```

Add the two new args inside the `search` `args` object (alongside `filterBy`/`facetBy`/`maxFacetValues`):
```ts
    rankBy: v.optional(
      v.object({
        text: v.optional(v.number()),
        fields: v.optional(
          v.array(v.object({ field: v.string(), weight: v.number() })),
        ),
      }),
    ),
    sortBy: v.optional(
      v.array(
        v.object({
          field: v.string(),
          order: v.union(v.literal("asc"), v.literal("desc")),
        }),
      ),
    ),
```

In the handler, collect `matchedTerms` while iterating tokens. In the `else` (non-empty-q) branch, the loop currently does `const candidates = await candidateTermsForToken(...)`. Declare `const matchedTerms = new Set<string>();` BEFORE the `if (tokens.length === 0)` block, and inside the token loop add `for (const term of candidates.keys()) matchedTerms.add(term);`. So the loop body becomes:
```ts
      for (let i = 0; i < tokens.length; i++) {
        const candidates = await candidateTermsForToken(
          ctx,
          args.collection,
          tokens[i],
          i === tokens.length - 1,
        );
        for (const term of candidates.keys()) matchedTerms.add(term);
        perToken.push(
          await docScoresForToken(ctx, args.collection, candidates, args.queryBy),
        );
      }
```

Replace the sort block (the `if (scoreById) { matchedIds.sort(...) } else { matchedIds.sort() }`) with rank/sort via `ranking.ts`:
```ts
    const rawScore = (id: string) => (scoreById ? (scoreById.get(id) ?? 0) : 0);
    const orderScore = (id: string) =>
      orderingScore(rawScore(id), (byId.get(id) ?? {}) as Record<string, unknown>, args.rankBy);
    matchedIds.sort((a, b) =>
      compareMatches(a, b, {
        score: orderScore,
        stored: (id) => (byId.get(id) ?? {}) as Record<string, unknown>,
        sortBy: args.sortBy,
      }),
    );
```
(Note: this single sort replaces both prior branches. `found` is still computed before this, faceting still after — keep their positions; faceting iterates `matchedIds` which is now ordered, order does not affect counts.)

Replace the `hits` construction to add highlighting and keep raw `text_match`:
```ts
    const fields = args.queryBy ?? collection.searchFields;
    const hits: Hit[] = pageIds.map((id) => {
      const stored = (byId.get(id) ?? {}) as Record<string, unknown>;
      const highlight: Record<string, { snippet: string; matched_tokens: string[] }> = {};
      if (matchedTerms.size > 0) {
        for (const field of fields) {
          const value = stored[field];
          if (typeof value !== "string") continue;
          const h = highlightField(value, matchedTerms);
          if (h) highlight[field] = h;
        }
      }
      return { document: stored, highlight, text_match: rawScore(id) };
    });
```

Ensure `matchedTerms` is in scope for the hits builder (declared before the branches). Remove the now-unused old `text_match: scoreById ? ...` inline (replaced by `rawScore(id)`).

- [ ] **Step 4: Regenerate + run the whole suite**

Run: `npm run build:codegen && npx vitest run`
Expected: ALL pass — prior tests (filter/facet/typo/prefix/ranking) plus the 6 new highlight/sort tests. The default ordering still matches prior expectations (score desc, docId asc), so no regressions. If a prior test breaks, STOP and report.

- [ ] **Step 5: Commit**

```bash
git add src/component/types.ts src/component/search.ts src/component/search.test.ts src/component/_generated
git commit -m "feat: highlighting + rankBy/sortBy ordering in search"
```

---

## Task 4: Client passthrough

**Files:** Modify `src/client/index.ts`.

- [ ] **Step 1: Extend the client `search` signature**

In `src/client/index.ts`, add `rankBy` and `sortBy` to the `search` method's args type (passthrough body unchanged):
```ts
    args: {
      collection: string;
      q: string;
      page?: number;
      perPage?: number;
      queryBy?: string[];
      filterBy?: string;
      facetBy?: string[];
      maxFacetValues?: number;
      rankBy?: { text?: number; fields?: { field: string; weight: number }[] };
      sortBy?: { field: string; order: "asc" | "desc" }[];
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
git commit -m "feat: client passthrough for rankBy/sortBy"
```

---

## Task 5: Example — sort dropdown + highlighted results + verify

**Files:** Modify `example/convex/products.ts`, `example/src/Storefront.tsx`, `example/src/components/ProductGrid.tsx`, `example/src/components/FacetSidebar.tsx`.

- [ ] **Step 1: Pass `sortBy` through in `example/convex/products.ts`**

Add `sortBy` to `searchProducts` args + passthrough:
```ts
export const searchProducts = query({
  args: {
    q: v.string(),
    page: v.optional(v.number()),
    perPage: v.optional(v.number()),
    filterBy: v.optional(v.string()),
    facetBy: v.optional(v.array(v.string())),
    sortBy: v.optional(
      v.array(
        v.object({
          field: v.string(),
          order: v.union(v.literal("asc"), v.literal("desc")),
        }),
      ),
    ),
  },
  handler: async (ctx, args) =>
    search.search(ctx, { collection: COLLECTION, ...args }),
});
```

- [ ] **Step 2: Render the highlighted name in `example/src/components/ProductGrid.tsx`**

Replace the product name line so it renders the highlight snippet when present (falls back to plain name):
```tsx
type Hit = {
  document: Record<string, any>;
  highlight?: { name?: { snippet: string } };
};

export function ProductGrid({ hits }: { hits: Hit[] }) {
  if (hits.length === 0) return <p>No products found.</p>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 16 }}>
      {hits.map((h) => (
        <div key={h.document.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <img src={h.document.image} alt={h.document.name} style={{ width: "100%", borderRadius: 4 }} />
          <div
            style={{ fontWeight: 600 }}
            // snippet is HTML-escaped by the component except for <mark> tags
            dangerouslySetInnerHTML={{
              __html: h.highlight?.name?.snippet ?? h.document.name,
            }}
          />
          <div style={{ color: "#666", fontSize: 13 }}>{h.document.brand}</div>
          <div>${h.document.price}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Add a sort dropdown in `example/src/Storefront.tsx`**

Add sort state + a `<select>`, and pass `sortBy` into the query. Insert near the search bar row and wire it. Replace the `Storefront` component body with:
```tsx
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { SearchBar } from "./components/SearchBar";
import { ProductGrid } from "./components/ProductGrid";
import { FacetSidebar } from "./components/FacetSidebar";

const PER_PAGE = 4;

const SORTS = {
  relevance: undefined,
  "price-asc": [{ field: "price", order: "asc" as const }],
  "price-desc": [{ field: "price", order: "desc" as const }],
};
type SortKeyName = keyof typeof SORTS;

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
  const [sort, setSort] = useState<SortKeyName>("relevance");
  const seed = useMutation(api.products.seed);

  const filterBy = buildFilterBy(selected);
  const result = useQuery(api.products.searchProducts, {
    q,
    page,
    perPage: PER_PAGE,
    filterBy,
    facetBy: ["brand", "category"],
    sortBy: SORTS[sort],
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
          <select value={sort} onChange={(e) => { setSort(e.target.value as SortKeyName); setPage(1); }}>
            <option value="relevance">Relevance</option>
            <option value="price-asc">Price ↑</option>
            <option value="price-desc">Price ↓</option>
          </select>
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

- [ ] **Step 4: Deploy + verify on the live deployment (from repo root)**

```bash
npm run build:codegen
npx convex dev --once         # skip if a watcher already holds the deployment
npx convex run products:seed  # { seeded: 6 }
```
Verify (report actual output):
```bash
npx convex run products:searchProducts '{"q":"running"}'
# expect hits with highlight.name.snippet containing <mark>...</mark>
npx convex run products:searchProducts '{"q":"","sortBy":[{"field":"price","order":"asc"}]}'
# expect ascending price order
```
Then confirm the frontend compiles:
```bash
npm run typecheck
cd example && npx vite build
```
Expected: typecheck clean; vite build succeeds (remove example/dist before commit if created).

- [ ] **Step 5: Commit**

```bash
cd /Users/newuser/convex_component
git add example
git commit -m "feat: sort dropdown + highlighted results in example"
```

---

## Task 6: README + final verification

**Files:** Modify `README.md`.

- [ ] **Step 1: Update `README.md`**

- Move highlighting + weighted/multi-key sort OUT of "Roadmap & limitations" INTO Features and the `search` API docs:
  - Highlighting: each matched search field returns `{ snippet (with `<mark>`), matched_tokens }` in `highlight`; HTML-escaped, browse mode → `{}`.
  - `rankBy`: weighted blend `{ text?, fields:[{field,weight}] }` → `score = (text??1)*text_match + Σ weight*Number(field||0)`.
  - `sortBy`: `[{field, order}]` multi-key (`_text_match` or numeric fields), lexicographic, `docId` tie-break; default = relevance desc.
  - Note reported `text_match` stays the raw relevance score (ordering only).
- Update the output-shape example so `highlight` shows a populated `{ name: { snippet, matched_tokens } }`.
- KEEP remaining limits: no windowed snippets (full-value only), `<mark>` fixed, sort/rank in-memory bounded-scale; Phase 4 = arbitrary-scale hardening (sharding, indexed filters/sort, array facets).
- Verify every claim against `highlight.ts`, `ranking.ts`, `search.ts`, `client/index.ts`, `types.ts`.

- [ ] **Step 2: Final verification**

```bash
npx vitest run
npm run build
npm run typecheck
```
Expected: all tests pass; no TS errors; typecheck clean.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document highlighting + weighted/multi-key sort"
```

---

## Self-Review notes (reconciled against the spec)

- **Spec coverage:** full-value highlight with `<mark>` + `matched_tokens`, browse → `{}`, HTML-escaped ✔ (Task 1 + Task 3 integration); `matchedTerms` from candidate union ✔ (Task 3 Step 3); searchFields∩queryBy fields, skip non-string/absent ✔ (Task 3); `rankBy` weighted blend with text default 1 + NaN→0 ✔ (Task 2); `sortBy` multi-key with `_text_match`/numeric, lexicographic, docId tie-break, default relevance desc ✔ (Task 2); composition (rankBy defines `_text_match` value, sortBy orders) ✔ (Task 3 `orderScore` fed into `compareMatches`); reported `text_match` stays raw ✔ (Task 3 `rawScore`); invalid `order` rejected by the union validator ✔ (Task 3 args); client passthrough ✔ (Task 4); example sort dropdown + highlight render ✔ (Task 5); README ✔ (Task 6).
- **Type consistency:** `RankBy`/`SortKey` exported from `ranking.ts` and used in its test; `Hit.highlight` tightened in `types.ts` and produced identically in `search.ts`; client arg types mirror the search validators; `orderingScore(textMatch, stored, rankBy)` and `compareMatches(a,b,{score,stored,sortBy})` signatures identical across Task 2 and Task 3.
- **Regression guard:** the single rank/sort `compareMatches` with default `[{_text_match,desc}]` + docId tie-break reproduces the prior score-desc/docId-asc order, so existing search/typo/prefix/filter tests stay green; faceting still runs after sort over the same `matchedIds` (order-independent counts).
- **Safety:** snippet HTML-escapes field text, only `<mark>` is literal — the example's `dangerouslySetInnerHTML` renders component-produced safe HTML.
