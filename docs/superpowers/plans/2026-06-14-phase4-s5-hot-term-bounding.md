# Phase 4 S5 — Hot-Term Postings Bounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound per-query postings reads in the text path — drive the AND intersection from the most selective token (exact) and cap the driver scan with a `found_approximate` flag for the pathological hot-term residue.

**Architecture:** `candidateTermsForToken` returns each candidate's `docCount` (already in the `terms` table). A new `textSearch.ts` orchestrator picks the smallest-`docCount` token as the driver, collects only its postings (capped at `POSTINGS_BUDGET`), and verifies the other tokens by per-doc `by_collection_doc` lookups — so reads scale with result size, not corpus frequency. `search.ts` calls it, threads `truncated → found_approximate`, and reports exact `found` from `terms.docCount` for a truncated single-exact-term query.

**Tech Stack:** Convex component (TypeScript), `convex-test` + `vitest`.

**Spec:** `docs/superpowers/specs/2026-06-14-phase4-s5-hot-term-bounding-design.md`

**Conventions (read before starting):**
- `verbatimModuleSyntax` on → `import type` for type-only imports.
- Tests calling `api.write.*` / `api.search.*` register the aggregate(s): `registerAggregate(t, "docCount")` (and `"sortIndex"` only if the collection declares `sortSpecs` — not needed for S5 fixtures). Import `register as registerAggregate` from `@convex-dev/aggregate/test`.
- Run one test file: `npx vitest run src/component/<file>`. All: `npx vitest run`. Build/typecheck: `npm run build`.
- Current text path in `search.ts` (post-S4): a module-level `async function docScoresForToken(ctx, collection, candidates: Map<string, number>, queryBy)` collects postings per candidate term; the handler's text branch (`if (tokens.length > 0)`) loops tokens calling `candidateTermsForToken` + `docScoresForToken`, pushing per-token `Map<string,number>` into `perToken`, then sorts `perToken` by size and intersects smallest-first to build `scoreById`, accumulating `matchedTerms`. S5 replaces this inline block + removes `docScoresForToken`.
- Scoring semantics to preserve exactly: per token, a doc's contribution is the **best** candidate score among that token's candidate terms present on the doc (honoring `queryBy`); a doc must match **every** token (AND); the doc's total score is the **sum** of per-token best scores.
- `text_match` reported per hit stays the raw summed score (`scoreById`).

---

### Task 1: `candidateTermsForToken` returns docCount

**Files:**
- Modify: `src/component/matching.ts`
- Modify: `src/component/matching.test.ts`

- [ ] **Step 1: Update the test to the new shape**

Open `src/component/matching.test.ts`. Its assertions currently treat the return as `Map<string, number>` (score). Update them to the new `Map<string, { score: number; docCount: number }>` shape. Concretely, wherever a test reads a candidate's value as a number, change it to read `.score` (and add `.docCount` assertions where a fixture's document frequency is known). For example, an assertion like:

```ts
expect(out.get("running")).toBe(3);
```

becomes:

```ts
expect(out.get("running")).toEqual({ score: 3, docCount: 1 });
```

Apply the analogous change to every assertion in the file that inspects the returned map's values (exact → `{ score: 3, docCount: <n> }`, prefix → `{ score: 2, docCount: <n> }`, fuzzy → `{ score: <typoScore>, docCount: <n> }`). Use the actual `docCount` each fixture implies (number of seeded docs containing that term). Keep all existing term-membership and score expectations otherwise identical.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/component/matching.test.ts`
Expected: FAIL — current implementation returns numbers, not `{ score, docCount }`.

- [ ] **Step 3: Implement the new return shape**

In `src/component/matching.ts`:

(a) Change the function signature and the internal map:

```ts
export async function candidateTermsForToken(
  ctx: QueryCtx,
  collection: string,
  token: string,
  isLast: boolean,
): Promise<Map<string, { score: number; docCount: number }>> {
  const out = new Map<string, { score: number; docCount: number }>();
  const setBest = (term: string, score: number, docCount: number) => {
    const cur = out.get(term);
    if (cur === undefined || score > cur.score) out.set(term, { score, docCount });
  };
```

(b) Exact branch — the `terms` row carries `docCount`:

```ts
  const exact = await ctx.db
    .query("terms")
    .withIndex("by_collection_term", (q) =>
      q.eq("collection", collection).eq("term", token),
    )
    .unique();
  if (exact) setBest(token, EXACT, exact.docCount);
```

(c) Prefix branch — each row carries `docCount`:

```ts
  if (isLast) {
    const rows = await ctx.db
      .query("terms")
      .withIndex("by_collection_term", (q) =>
        q.eq("collection", collection).gte("term", token).lt("term", token + HIGH),
      )
      .collect();
    for (const r of rows) setBest(r.term, PREFIX, r.docCount);
  }
```

(d) Fuzzy branch — after a candidate passes the Levenshtein check, look up its `docCount` from the `terms` table (bounded by the number of surviving fuzzy candidates):

```ts
    for (const [term, count] of overlap) {
      if (count < threshold) continue;
      if (out.get(term)?.score === EXACT) continue;
      const d = levenshtein(token, term, budget);
      if (d <= budget) {
        const row = await ctx.db
          .query("terms")
          .withIndex("by_collection_term", (q) =>
            q.eq("collection", collection).eq("term", term),
          )
          .unique();
        setBest(term, typoScore(d), row?.docCount ?? 0);
      }
    }
```

(Note the `out.get(term)?.score === EXACT` guard replaces the old `out.get(term) === EXACT`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/component/matching.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck (surfaces the search.ts consumer break)**

Run: `npm run build`
Expected: TypeScript ERRORS in `src/component/search.ts` (it still treats candidates as `Map<string, number>`). That is expected — Task 2/3 fix the consumer. Do NOT edit search.ts in this task. (If you prefer a green build between tasks, this is the one acceptable exception; the next task restores it. Proceed to commit.)

- [ ] **Step 6: Commit**

```bash
git add src/component/matching.ts src/component/matching.test.ts
git commit -m "feat(s5): candidateTermsForToken returns per-candidate docCount"
```

---

### Task 2: `textSearch.ts` — driver intersection + budget cap

**Files:**
- Create: `src/component/textSearch.ts`
- Create: `src/component/textSearch.test.ts`

**Interface:**
```ts
matchTokens(
  ctx: QueryCtx,
  collection: string,
  tokens: string[],
  queryBy: string[] | undefined,
  budget?: number, // default POSTINGS_BUDGET; internal seam for tests
): Promise<{
  scoreById: Map<string, number>;
  matchedTerms: Set<string>;
  truncated: boolean;
  singleExactTerm: string | null;
}>
```

- [ ] **Step 1: Write the failing test**

Create `src/component/textSearch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";
import { matchTokens } from "./textSearch";

const modules = import.meta.glob("./**/*.ts");

async function seeded() {
  const t = convexTest(schema, modules);
  registerAggregate(t, "docCount");
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
  });
  // "shoe" is common (3 docs); "waterproof" is rare (1 doc).
  const docs = [
    { id: "1", doc: { name: "waterproof shoe" } },
    { id: "2", doc: { name: "running shoe" } },
    { id: "3", doc: { name: "leather shoe" } },
  ];
  for (const d of docs) await t.mutation(api.write.upsert, { collection: "shop", ...d });
  return t;
}

describe("matchTokens", () => {
  it("multi-term AND drives from the rare token and returns the intersection", async () => {
    const t = await seeded();
    const r = await t.run((ctx: any) => matchTokens(ctx, "shop", ["waterproof", "shoe"], undefined));
    expect([...r.scoreById.keys()].sort()).toEqual(["1"]);
    expect(r.scoreById.get("1")).toBe(6); // exact(3) + exact(3)
    expect(r.truncated).toBe(false);
    expect(r.singleExactTerm).toBeNull();
    expect(r.matchedTerms.has("waterproof")).toBe(true);
    expect(r.matchedTerms.has("shoe")).toBe(true);
  });

  it("single common term matches all docs containing it", async () => {
    const t = await seeded();
    const r = await t.run((ctx: any) => matchTokens(ctx, "shop", ["shoe"], undefined));
    expect([...r.scoreById.keys()].sort()).toEqual(["1", "2", "3"]);
    expect(r.singleExactTerm).toBe("shoe");
    expect(r.truncated).toBe(false);
  });

  it("respects queryBy (no postings in an excluded field -> no match)", async () => {
    const t = await seeded();
    // searchFields is ["name"]; querying a non-indexed field yields nothing.
    const r = await t.run((ctx: any) => matchTokens(ctx, "shop", ["shoe"], ["title"]));
    expect(r.scoreById.size).toBe(0);
  });

  it("a token with no candidate terms yields an empty AND result", async () => {
    const t = await seeded();
    const r = await t.run((ctx: any) => matchTokens(ctx, "shop", ["shoe", "zzzzzzzz"], undefined));
    expect(r.scoreById.size).toBe(0);
  });

  it("budget cap truncates the driver scan and flags it", async () => {
    const t = await seeded();
    // budget 1: only one posting of the driver term is read -> truncated.
    const r = await t.run((ctx: any) => matchTokens(ctx, "shop", ["shoe"], undefined, 1));
    expect(r.truncated).toBe(true);
    expect(r.scoreById.size).toBeLessThanOrEqual(1);
    expect(r.singleExactTerm).toBe("shoe");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/component/textSearch.test.ts`
Expected: FAIL — `./textSearch` does not exist.

- [ ] **Step 3: Implement `textSearch.ts`**

Create `src/component/textSearch.ts`:

```ts
import type { QueryCtx } from "./_generated/server";
import { candidateTermsForToken } from "./matching";

// Max postings rows read while collecting the driver token. Headroom under the
// ~4096 reads/query limit. Exceeding it truncates the driver scan (approximate).
export const POSTINGS_BUDGET = 4000;

type Candidates = Map<string, { score: number; docCount: number }>;

// Best candidate score for a doc given the terms present on it (already filtered
// to this token's candidates), or undefined if none present.
function bestScore(present: Map<string, number>, candidates: Candidates): number | undefined {
  let best: number | undefined;
  for (const [term, _tf] of present) {
    const c = candidates.get(term);
    if (c && (best === undefined || c.score > best)) best = c.score;
  }
  return best;
}

export async function matchTokens(
  ctx: QueryCtx,
  collection: string,
  tokens: string[],
  queryBy: string[] | undefined,
  budget: number = POSTINGS_BUDGET,
): Promise<{
  scoreById: Map<string, number>;
  matchedTerms: Set<string>;
  truncated: boolean;
  singleExactTerm: string | null;
}> {
  // 1. Candidates + selectivity per token.
  const perToken: { candidates: Candidates; est: number }[] = [];
  const matchedTerms = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const candidates = await candidateTermsForToken(ctx, collection, tokens[i], i === tokens.length - 1);
    let est = 0;
    for (const [term, c] of candidates) {
      matchedTerms.add(term);
      est += c.docCount;
    }
    perToken.push({ candidates, est });
  }

  if (perToken.length === 0) {
    return { scoreById: new Map(), matchedTerms, truncated: false, singleExactTerm: null };
  }

  // singleExactTerm: exactly one token whose only candidate is the token itself
  // at EXACT score (enables exact found from terms.docCount when truncated).
  let singleExactTerm: string | null = null;
  if (tokens.length === 1) {
    const only = perToken[0].candidates;
    if (only.size === 1 && only.has(tokens[0])) singleExactTerm = tokens[0];
  }

  // 2. Driver = most selective token (smallest estimated docCount).
  let driverIdx = 0;
  for (let i = 1; i < perToken.length; i++) {
    if (perToken[i].est < perToken[driverIdx].est) driverIdx = i;
  }
  const driver = perToken[driverIdx];

  // 3. Collect driver postings (budget-capped) -> docId -> best driver score.
  const driverScore = new Map<string, number>();
  let read = 0;
  let truncated = false;
  outer: for (const [term, c] of driver.candidates) {
    const rows = await ctx.db
      .query("postings")
      .withIndex("by_collection_term", (q) => q.eq("collection", collection).eq("term", term))
      .collect();
    for (const r of rows) {
      if (read >= budget) { truncated = true; break outer; }
      read++;
      if (queryBy && !queryBy.includes(r.field)) continue;
      const cur = driverScore.get(r.docId);
      if (cur === undefined || c.score > cur) driverScore.set(r.docId, c.score);
    }
  }

  // 4. Verify the other tokens per driver doc. Read each driver doc's postings
  //    ONCE, then check every non-driver token against that single term set.
  const others = perToken.filter((_, i) => i !== driverIdx);
  const scoreById = new Map<string, number>();
  for (const [docId, dScore] of driverScore) {
    let present: Map<string, number> | null = null;
    if (others.length > 0) {
      const postings = await ctx.db
        .query("postings")
        .withIndex("by_collection_doc", (q) => q.eq("collection", collection).eq("docId", docId))
        .collect();
      present = new Map<string, number>();
      for (const p of postings) {
        if (queryBy && !queryBy.includes(p.field)) continue;
        present.set(p.term, p.tf);
      }
    }
    let total = dScore;
    let ok = true;
    for (const tok of others) {
      const s = bestScore(present as Map<string, number>, tok.candidates);
      if (s === undefined) { ok = false; break; }
      total += s;
    }
    if (ok) scoreById.set(docId, total);
  }

  return { scoreById, matchedTerms, truncated, singleExactTerm };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/component/textSearch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/component/textSearch.ts src/component/textSearch.test.ts
git commit -m "feat(s5): textSearch.matchTokens — driver intersection + budget cap"
```

---

### Task 3: Wire `matchTokens` into `search.ts` + `found_approximate`

**Files:**
- Modify: `src/component/types.ts`
- Modify: `src/component/search.ts`

- [ ] **Step 1: Add `found_approximate` to the result type**

In `src/component/types.ts`, add the field to `SearchResult`:

```ts
export type SearchResult = {
  found: number;
  found_approximate: boolean;
  page: number;
  out_of: number;
  search_time_ms: number;
  hits: Hit[];
  facet_counts: FacetCount[];
};
```

- [ ] **Step 2: Run to verify the build fails**

Run: `npm run build`
Expected: TypeScript ERRORS — every `return { ... }` in `search.ts` now lacks `found_approximate`. (Confirms all return sites are found.) Proceed to fix them.

- [ ] **Step 3: Replace the text-matching block + thread the flag in `search.ts`**

In `src/component/search.ts`:

(a) Remove the module-level `docScoresForToken` function entirely.

(b) Add imports near the top (with the other component imports):

```ts
import { matchTokens } from "./textSearch";
```

(c) Replace the text-path block. The current text branch looks like:

```ts
    if (tokens.length > 0) {
      // TEXT PATH: candidate set from postings; intersect with filter; load only those docs.
      const perToken: Map<string, number>[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const candidates = await candidateTermsForToken(ctx, args.collection, tokens[i], i === tokens.length - 1);
        for (const term of candidates.keys()) matchedTerms.add(term);
        perToken.push(await docScoresForToken(ctx, args.collection, candidates, args.queryBy));
      }
      perToken.sort((a, b) => a.size - b.size);
      const [first, ...rest] = perToken;
      scoreById = new Map();
      if (first) {
        for (const [docId, s0] of first) {
          if (rest.every((m) => m.has(docId))) {
            let total = s0;
            for (const m of rest) total += m.get(docId)!;
            scoreById.set(docId, total);
          }
        }
      }
      matchedIds = [...scoreById.keys()];
      if (filterIds) matchedIds = matchedIds.filter((id) => filterIds!.has(id));
      byId = await loadDocs(ctx, args.collection, matchedIds);
    } else if (filterIds) {
```

Replace the body of the `if (tokens.length > 0) { ... }` branch (keep the `else if (filterIds)` / `else` branches that follow) with:

```ts
    if (tokens.length > 0) {
      // TEXT PATH: driver-token intersection (bounded). Intersect with filter; load only matched docs.
      const m = await matchTokens(ctx, args.collection, tokens, args.queryBy);
      scoreById = m.scoreById;
      for (const term of m.matchedTerms) matchedTerms.add(term);
      truncated = m.truncated;
      singleExactTerm = m.singleExactTerm;
      matchedIds = [...scoreById.keys()];
      if (filterIds) matchedIds = matchedIds.filter((id) => filterIds!.has(id));
      byId = await loadDocs(ctx, args.collection, matchedIds);
    } else if (filterIds) {
```

(d) Declare the two new locals alongside the existing `matchedIds`/`scoreById`/`matchedTerms` declarations (just before the `if (tokens.length > 0)` block). The existing declarations are:

```ts
    let matchedIds: string[];
    let scoreById: Map<string, number> | null = null;
    const matchedTerms = new Set<string>();
    let byId: Map<string, unknown>;
```

Add after them:

```ts
    let truncated = false;
    let singleExactTerm: string | null = null;
```

(e) Remove the now-unused `candidateTermsForToken` import if `search.ts` no longer references it directly (it is only used inside `textSearch.ts` now). Check the import line `import { candidateTermsForToken } from "./matching";` and delete it if there are no remaining references in `search.ts`.

(f) Compute `found` and `found_approximate`. The current code has, after the working-set block:

```ts
    const found = matchedIds.length;
```

Replace it with:

```ts
    let found = matchedIds.length;
    let found_approximate = false;
    if (truncated) {
      found_approximate = true;
      if (singleExactTerm && !filterIds) {
        const termRow = await ctx.db
          .query("terms")
          .withIndex("by_collection_term", (q) =>
            q.eq("collection", args.collection).eq("term", singleExactTerm as string),
          )
          .unique();
        if (termRow) found = termRow.docCount;
      }
    }
```

(g) Add `found_approximate` to the text/filter/full-load path's final return (the last `return` in the handler):

```ts
    return { found, found_approximate, page, out_of, search_time_ms: Date.now() - start, hits, facet_counts };
```

(h) Add `found_approximate: false` to every OTHER early-return in the handler — the lean-browse return, the lean browse+facets return, and the lean browse+sort return. Each currently ends `return { found: ..., page, out_of, search_time_ms: ..., hits, facet_counts };` — insert `found_approximate: false,` after the `found: ...,` field in each.

- [ ] **Step 4: Build + run the full suite**

Run: `npm run build && npx vitest run`
Expected: build clean; all existing tests pass. Existing `search.test.ts` text queries return identical hits/scores (driver intersection preserves scoring), now with `found_approximate: false`.

- [ ] **Step 5: Commit**

```bash
git add src/component/types.ts src/component/search.ts
git commit -m "feat(s5): bounded text path in search + found_approximate flag"
```

---

### Task 4: Search-level coverage + example surfacing

**Files:**
- Create: `src/component/search-approximate.test.ts`
- Modify: `example/src/Storefront.tsx`

- [ ] **Step 1: Write the search-level test**

Create `src/component/search-approximate.test.ts`:

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
  await t.mutation(api.collections.createCollection, {
    name: "shop",
    searchFields: ["name"],
    storedFields: "all",
    facetFields: ["brand"],
  });
  const docs = [
    { id: "1", doc: { id: "1", name: "waterproof shoe", brand: "A" } },
    { id: "2", doc: { id: "2", name: "running shoe", brand: "B" } },
    { id: "3", doc: { id: "3", name: "leather shoe", brand: "A" } },
  ];
  for (const d of docs) await t.mutation(api.write.upsert, { collection: "shop", ...d });
  return t;
}

describe("found_approximate is present and exact by default", () => {
  it("text query: exact found, flag false", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "shoe" });
    expect(r.found).toBe(3);
    expect(r.found_approximate).toBe(false);
  });

  it("multi-term AND text query is exact", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "waterproof shoe" });
    expect(r.found).toBe(1);
    expect(r.found_approximate).toBe(false);
  });

  it("browse path reports found_approximate false", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "" });
    expect(r.found).toBe(3);
    expect(r.found_approximate).toBe(false);
  });

  it("filter path reports found_approximate false", async () => {
    const t = await seeded();
    const r = await t.query(api.search.search, { collection: "shop", q: "", filterBy: "brand:A" });
    expect(r.found).toBe(2);
    expect(r.found_approximate).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run src/component/search-approximate.test.ts`
Expected: PASS (4 tests). (These assert the flag plumbing and the exact-by-default contract; truncation behavior is covered at the `matchTokens` unit level in Task 2.)

- [ ] **Step 3: Surface the flag in the example storefront**

In `example/src/Storefront.tsx`, find the result-count line:

```tsx
        <p>{result ? `${result.found} results · ${result.search_time_ms} ms` : "Loading…"}</p>
```

Replace it with:

```tsx
        <p>
          {result
            ? `${result.found_approximate ? "≈" : ""}${result.found} results · ${result.search_time_ms} ms`
            : "Loading…"}
        </p>
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run build && npx vitest run`
Expected: build/typecheck clean (the example uses `result.found_approximate`, now on `SearchResult`); all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/component/search-approximate.test.ts example/src/Storefront.tsx
git commit -m "feat(s5): search-level approximate-flag coverage + storefront ≈ hint"
```

---

## Self-Review

**1. Spec coverage:**
- `candidateTermsForToken` returns `docCount` → Task 1. ✓
- Driver-token intersection (smallest-docCount driver; collect driver postings; verify others via `by_collection_doc`; preserve AND/best/sum scoring) → Task 2 (`matchTokens`). ✓
- Budget cap + `truncated` → Task 2 (`POSTINGS_BUDGET`, `budget` seam). ✓
- `singleExactTerm` for exact `found` → Task 2 (computed) + Task 3 (used). ✓
- `found_approximate` on envelope; `found = terms.docCount` for truncated single-exact-term (and `!filterIds`) → Task 3. ✓
- All non-text paths set `found_approximate: false` → Task 3 Step 3h. ✓
- `queryBy` honored in driver + membership → Task 2 (both loops filter on `r.field`/`p.field`); tested. ✓
- Client unchanged (re-exports `SearchResult`) → no client task needed. ✓
- Example surfaces the flag → Task 4. ✓
- No backfill → none planned (reuses `terms.docCount` + postings). ✓

**2. Placeholder scan:** No TBD/vague steps; full code in every code step.

**3. Type consistency:**
- `candidateTermsForToken` returns `Map<string, { score: number; docCount: number }>` in Task 1; consumed only by `matchTokens` (Task 2) which reads `.score`/`.docCount`. ✓
- `matchTokens(ctx, collection, tokens, queryBy, budget?)` returns `{ scoreById; matchedTerms; truncated; singleExactTerm }` — defined Task 2, consumed Task 3 with matching field names. ✓
- `SearchResult.found_approximate: boolean` added Task 3 type; set at every return in Task 3 (text/filter/full-load + the three lean returns) and used in the example Task 4. ✓
- `search.ts` no longer references `docScoresForToken` or `candidateTermsForToken` after Task 3 (both removed/relocated). ✓

## Notes for the executor
- Tasks are dependency-ordered. Task 1 intentionally leaves `search.ts` with a type error (consumer updated in Task 3); that is the single acceptable red-build window — do not "fix" search.ts in Task 1 or Task 2 beyond what those tasks specify.
- Preserve scoring exactly: the golden check is that existing `search.test.ts` text-query expectations pass unchanged after Task 3.
- The membership lookup in `matchTokens` re-reads a driver doc's postings once per non-driver token. That is bounded by driver size × tokens (the result ceiling) and is the intended trade for not collecting hot terms. Do not micro-optimize it away in a manner that changes semantics.
- Do NOT add `found_approximate` to any search **arg** — it is output-only. The `budget` seam stays internal to `matchTokens`.
