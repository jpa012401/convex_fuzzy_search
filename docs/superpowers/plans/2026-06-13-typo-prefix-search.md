# Typo-Tolerant Prefix Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add prefix matching (last token), trigram-based typo tolerance, and relevance ranking to the existing exact-AND search, populating `text_match`.

**Architecture:** Two new component tables — `terms` (distinct-term dictionary + docCount ref-count) and `trigrams` (gram→term) — maintained synchronously in the write path via an old/new distinct-term diff. A pure `trigrams()` tokenizer helper and a pure `fuzzy.ts` (Levenshtein + typo budget). A query-side `matching.ts` resolves each token to candidate terms (exact ∪ prefix(last only) ∪ fuzzy), scored by quality; `search.ts` unions terms→docIds, ANDs across tokens, sums scores into `text_match`, and sorts by it.

**Tech Stack:** Convex (component), TypeScript (`verbatimModuleSyntax` ON — use `import type`), convex-test + Vitest. Tests are COLOCATED (`src/component/*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-06-13-typesense-convex-typo-prefix-search-design.md`

**Repo conventions (apply to every task):** colocated tests import `schema` from `./schema`, `api` from `./_generated/api`, glob `import.meta.glob("./**/*.ts")`. After any schema change run `npm run build:codegen`. Type-only imports use `import type`. A Convex deployment is configured (`.env.local`).

---

## File Structure

```
src/component/tokenizer.ts     # + trigrams()
src/component/fuzzy.ts          # NEW: typoBudget(len), levenshtein(a,b,max)
src/component/schema.ts         # + terms, trigrams tables
src/component/terms.ts          # NEW: applyTermDiff + trigram-aware inc/dec maintenance
src/component/write.ts          # call applyTermDiff with old/new distinct terms
src/component/matching.ts       # NEW: candidateTermsForToken(ctx, collection, token, isLast)
src/component/search.ts         # use matching.ts; AND; score; sort by text_match
README.md / example             # docs + verify search-as-you-type works
```

---

## Task 1: `trigrams()` tokenizer helper

**Files:** Modify `src/component/tokenizer.ts`; Test `src/component/tokenizer.test.ts` (append).

- [ ] **Step 1: Append failing tests to `src/component/tokenizer.test.ts`**

```ts
import { trigrams } from "./tokenizer";

describe("trigrams", () => {
  it("produces deduped contiguous 3-grams for length >= 3", () => {
    expect(trigrams("shoe")).toEqual(["sho", "hoe"]);
    expect(trigrams("aaaa")).toEqual(["aaa"]); // deduped
  });
  it("returns the whole term as one gram for length 1-2", () => {
    expect(trigrams("a")).toEqual(["a"]);
    expect(trigrams("re")).toEqual(["re"]);
  });
  it("returns [] for empty", () => {
    expect(trigrams("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/tokenizer.test.ts`
Expected: FAIL — `trigrams` is not exported.

- [ ] **Step 3: Implement in `src/component/tokenizer.ts` (append)**

```ts
// Generate de-duplicated contiguous 3-grams of a term, preserving first-seen order.
// Terms shorter than 3 chars yield the whole term as a single gram. Shared by
// write-path indexing and query-time fuzzy candidate generation.
export function trigrams(term: string): string[] {
  if (typeof term !== "string" || term.length === 0) return [];
  if (term.length < 3) return [term];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i + 3 <= term.length; i++) {
    const g = term.slice(i, i + 3);
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run src/component/tokenizer.test.ts`
Expected: PASS (all tokenizer tests, including the 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/component/tokenizer.ts src/component/tokenizer.test.ts
git commit -m "feat: add trigrams() tokenizer helper"
```

---

## Task 2: `fuzzy.ts` — typo budget + bounded Levenshtein

**Files:** Create `src/component/fuzzy.ts`; Test `src/component/fuzzy.test.ts`.

- [ ] **Step 1: Write failing test `src/component/fuzzy.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { typoBudget, levenshtein } from "./fuzzy";

describe("typoBudget", () => {
  it("scales with token length (Typesense-style)", () => {
    expect(typoBudget(1)).toBe(0);
    expect(typoBudget(3)).toBe(0);
    expect(typoBudget(4)).toBe(1);
    expect(typoBudget(7)).toBe(1);
    expect(typoBudget(8)).toBe(2);
    expect(typoBudget(20)).toBe(2);
  });
});

describe("levenshtein", () => {
  it("returns exact distance within budget", () => {
    expect(levenshtein("phone", "fone", 2)).toBe(1);
    expect(levenshtein("running", "runing", 2)).toBe(1);
    expect(levenshtein("abc", "abc", 1)).toBe(0);
  });
  it("returns a value greater than max when distance exceeds budget (early cutoff)", () => {
    expect(levenshtein("runners", "running", 1)).toBeGreaterThan(1);
    expect(levenshtein("apple", "zzzzz", 1)).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/fuzzy.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/component/fuzzy.ts`**

```ts
// Typo budget by token length (Typesense-style): tiny tokens tolerate no typos.
export function typoBudget(len: number): number {
  if (len <= 3) return 0;
  if (len <= 7) return 1;
  return 2;
}

// Bounded Levenshtein edit distance. Returns the true distance when it is <= max,
// otherwise returns a value strictly greater than max (caller treats that as "no match").
// Early-exits a row once its best possible value exceeds max.
export function levenshtein(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run src/component/fuzzy.test.ts`
Expected: PASS (2 describes).

- [ ] **Step 5: Commit**

```bash
git add src/component/fuzzy.ts src/component/fuzzy.test.ts
git commit -m "feat: add typo budget + bounded Levenshtein"
```

---

## Task 3: Schema — `terms` and `trigrams` tables

**Files:** Modify `src/component/schema.ts`.

- [ ] **Step 1: Add the two tables to `defineSchema` in `src/component/schema.ts`**

Add these table definitions inside the existing `defineSchema({ ... })` object (alongside `collections`, `documents`, `postings`):

```ts
  terms: defineTable({
    collection: v.string(),
    term: v.string(),
    docCount: v.number(), // number of docs in the collection containing this term
  }).index("by_collection_term", ["collection", "term"]),

  trigrams: defineTable({
    collection: v.string(),
    gram: v.string(),
    term: v.string(),
  })
    .index("by_collection_gram", ["collection", "gram"]) // fuzzy candidate lookup
    .index("by_collection_term", ["collection", "term"]), // cleanup when a term is removed
```

(Note: `trigrams` has TWO indexes — `by_collection_gram` for query-time candidate generation and `by_collection_term` so a term's trigram rows can be deleted when its `docCount` hits 0.)

- [ ] **Step 2: Regenerate + typecheck**

Run: `npm run build:codegen`
Expected: succeeds; `_generated/` now knows `terms` and `trigrams`; tsc clean.

- [ ] **Step 3: Commit**

```bash
git add src/component/schema.ts src/component/_generated
git commit -m "feat: add terms + trigrams tables"
```

---

## Task 4: `terms.ts` maintenance + write-path integration

**Files:** Create `src/component/terms.ts`; Modify `src/component/write.ts`; Test `src/component/terms.test.ts`.

- [ ] **Step 1: Write failing test `src/component/terms.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.collections.createCollection, {
    name: "products",
    searchFields: ["name"],
  });
  return t;
}

const termsFor = (t: any) =>
  t.run(async (ctx: any) =>
    ctx.db
      .query("terms")
      .withIndex("by_collection_term", (q: any) => q.eq("collection", "products"))
      .collect(),
  );
const trigramsForTerm = (t: any, term: string) =>
  t.run(async (ctx: any) =>
    ctx.db
      .query("trigrams")
      .withIndex("by_collection_term", (q: any) =>
        q.eq("collection", "products").eq("term", term),
      )
      .collect(),
  );

describe("terms + trigrams maintenance", () => {
  it("upsert creates term rows (docCount 1) and trigram rows", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "running shoe" },
    });
    const terms = await termsFor(t);
    expect(terms.map((x: any) => x.term).sort()).toEqual(["running", "shoe"]);
    expect(terms.every((x: any) => x.docCount === 1)).toBe(true);
    // "shoe" -> ["sho","hoe"]
    expect((await trigramsForTerm(t, "shoe")).map((x: any) => x.gram).sort()).toEqual(
      ["hoe", "sho"],
    );
  });

  it("a shared term across two docs has docCount 2 and no duplicate trigram rows", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "running shoe" } });
    await t.mutation(api.write.upsert, { collection: "products", id: "p2", doc: { name: "running jacket" } });
    const terms = await termsFor(t);
    const running = terms.find((x: any) => x.term === "running");
    expect(running.docCount).toBe(2);
    // "running" -> run,unn,nni,nin,ing  (5 unique grams); still one set, not doubled
    expect((await trigramsForTerm(t, "running")).length).toBe(5);
  });

  it("re-upsert dropping a term decrements/removes it", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "running shoe" } });
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "running" } });
    const terms = await termsFor(t);
    expect(terms.map((x: any) => x.term).sort()).toEqual(["running"]);
    expect(await trigramsForTerm(t, "shoe")).toEqual([]);
  });

  it("delete removes terms + trigrams when docCount hits 0", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, { collection: "products", id: "p1", doc: { name: "running shoe" } });
    await t.mutation(api.write.delete, { collection: "products", id: "p1" });
    expect(await termsFor(t)).toEqual([]);
    expect(await trigramsForTerm(t, "running")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/terms.test.ts`
Expected: FAIL — terms/trigrams not maintained yet (terms table empty).

- [ ] **Step 3: Implement `src/component/terms.ts`**

```ts
import type { MutationCtx } from "./_generated/server";
import { trigrams } from "./tokenizer";

async function loadTerm(ctx: MutationCtx, collection: string, term: string) {
  return await ctx.db
    .query("terms")
    .withIndex("by_collection_term", (q) =>
      q.eq("collection", collection).eq("term", term),
    )
    .unique();
}

async function incTerm(ctx: MutationCtx, collection: string, term: string) {
  const row = await loadTerm(ctx, collection, term);
  if (row) {
    await ctx.db.patch(row._id, { docCount: row.docCount + 1 });
    return;
  }
  await ctx.db.insert("terms", { collection, term, docCount: 1 });
  for (const gram of trigrams(term)) {
    await ctx.db.insert("trigrams", { collection, gram, term });
  }
}

async function decTerm(ctx: MutationCtx, collection: string, term: string) {
  const row = await loadTerm(ctx, collection, term);
  if (!row) return;
  if (row.docCount > 1) {
    await ctx.db.patch(row._id, { docCount: row.docCount - 1 });
    return;
  }
  await ctx.db.delete(row._id);
  const grams = await ctx.db
    .query("trigrams")
    .withIndex("by_collection_term", (q) =>
      q.eq("collection", collection).eq("term", term),
    )
    .collect();
  for (const g of grams) await ctx.db.delete(g._id);
}

// Apply the difference between a document's previous and current distinct terms.
export async function applyTermDiff(
  ctx: MutationCtx,
  collection: string,
  oldTerms: Set<string>,
  newTerms: Set<string>,
) {
  for (const term of newTerms) {
    if (!oldTerms.has(term)) await incTerm(ctx, collection, term);
  }
  for (const term of oldTerms) {
    if (!newTerms.has(term)) await decTerm(ctx, collection, term);
  }
}
```

- [ ] **Step 4: Wire `src/component/write.ts` to maintain terms**

Refactor the write path so both upsert and delete compute the document's old distinct terms, then call `applyTermDiff`. Replace the existing `deleteDocInternal`/`upsertInternal` internals with this structure (keep the public `upsert`/`deleteDoc`/`upsertMany` exports and the `export { deleteDoc as delete }` line unchanged):

```ts
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import { applyTermDiff } from "./terms";

type Doc = Record<string, unknown>;

function project(doc: Doc, storedFields: "all" | string[]): Doc {
  if (storedFields === "all") return doc;
  const out: Doc = {};
  for (const f of storedFields) {
    if (f in doc) out[f] = doc[f];
  }
  return out;
}

// Delete a doc's postings + document row; return its distinct terms (pre-deletion).
async function clearDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
): Promise<Set<string>> {
  const postings = await ctx.db
    .query("postings")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .collect();
  const oldTerms = new Set<string>(postings.map((p) => p.term));
  for (const p of postings) await ctx.db.delete(p._id);

  const existing = await ctx.db
    .query("documents")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .unique();
  if (existing) await ctx.db.delete(existing._id);

  return oldTerms;
}

async function upsertInternal(
  ctx: MutationCtx,
  collection: string,
  id: string,
  doc: Doc,
) {
  const col = await requireCollection(ctx, collection);
  const oldTerms = await clearDoc(ctx, collection, id);

  const newTerms = new Set<string>();
  for (const field of col.searchFields) {
    const value = doc[field];
    if (typeof value !== "string") continue;
    const counts = new Map<string, number>();
    for (const term of tokenize(value)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
      newTerms.add(term);
    }
    for (const [term, tf] of counts) {
      await ctx.db.insert("postings", { collection, term, docId: id, field, tf });
    }
  }

  await ctx.db.insert("documents", {
    collection,
    docId: id,
    stored: project(doc, col.storedFields),
  });

  await applyTermDiff(ctx, collection, oldTerms, newTerms);
}

export const upsert = mutation({
  args: { collection: v.string(), id: v.string(), doc: v.any() },
  handler: async (ctx, args) =>
    upsertInternal(ctx, args.collection, args.id, args.doc as Doc),
});

export const deleteDoc = mutation({
  args: { collection: v.string(), id: v.string() },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collection);
    const oldTerms = await clearDoc(ctx, args.collection, args.id);
    await applyTermDiff(ctx, args.collection, oldTerms, new Set());
  },
});

export const upsertMany = mutation({
  args: {
    collection: v.string(),
    docs: v.array(v.object({ id: v.string(), doc: v.any() })),
  },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collection);
    for (const { id, doc } of args.docs) {
      await upsertInternal(ctx, args.collection, id, doc as Doc);
    }
  },
});

export { deleteDoc as delete };
```

- [ ] **Step 5: Regenerate, run terms test AND the existing write test (no regressions)**

Run: `npm run build:codegen && npx vitest run src/component/terms.test.ts src/component/write.test.ts`
Expected: PASS — terms maintenance (4) + all existing write tests still green.

- [ ] **Step 6: Commit**

```bash
git add src/component/terms.ts src/component/write.ts src/component/terms.test.ts src/component/_generated
git commit -m "feat: maintain terms + trigrams in the write path"
```

---

## Task 5: `matching.ts` — candidate terms per token

**Files:** Create `src/component/matching.ts`; Test `src/component/matching.test.ts`.

- [ ] **Step 1: Write failing test `src/component/matching.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { candidateTermsForToken, EXACT, PREFIX } from "./matching";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.collections.createCollection, {
    name: "products",
    searchFields: ["name"],
  });
  // terms present after these: running, runners, shoe, jacket, phone
  await t.mutation(api.write.upsertMany, {
    collection: "products",
    docs: [
      { id: "p1", doc: { name: "running shoe runners" } },
      { id: "p2", doc: { name: "running jacket" } },
      { id: "p3", doc: { name: "phone" } },
    ],
  });
  return t;
}

describe("candidateTermsForToken", () => {
  it("exact match scores EXACT", async () => {
    const t = await setup();
    const m = await t.run(async (ctx: any) =>
      Object.fromEntries(await candidateTermsForToken(ctx, "products", "shoe", false)),
    );
    expect(m["shoe"]).toBe(EXACT);
  });

  it("prefix matches only when isLast", async () => {
    const t = await setup();
    const last = await t.run(async (ctx: any) =>
      Object.fromEntries(await candidateTermsForToken(ctx, "products", "run", true)),
    );
    expect(Object.keys(last).sort()).toEqual(["runners", "running"]);
    expect(last["running"]).toBe(PREFIX);

    const notLast = await t.run(async (ctx: any) =>
      Object.fromEntries(await candidateTermsForToken(ctx, "products", "run", false)),
    );
    // "run" is not a term; len 3 -> no fuzzy; not last -> no prefix
    expect(Object.keys(notLast)).toEqual([]);
  });

  it("fuzzy matches a typo within budget and scores below exact", async () => {
    const t = await setup();
    const m = await t.run(async (ctx: any) =>
      Object.fromEntries(await candidateTermsForToken(ctx, "products", "fone", false)),
    );
    expect(m["phone"]).toBeGreaterThan(0);
    expect(m["phone"]).toBeLessThan(EXACT);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/matching.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/component/matching.ts`**

```ts
import type { QueryCtx } from "./_generated/server";
import { trigrams } from "./tokenizer";
import { typoBudget, levenshtein } from "./fuzzy";

export const EXACT = 3;
export const PREFIX = 2;
// A typo at edit distance d scores 2 - 0.5*d (1 typo -> 1.5, 2 typos -> 1.0).
const typoScore = (d: number) => 2 - 0.5 * d;

// High code point used as an exclusive upper bound for a prefix range scan.
const HIGH = "￿";

// Returns a map of candidate term -> best match score for one query token.
export async function candidateTermsForToken(
  ctx: QueryCtx,
  collection: string,
  token: string,
  isLast: boolean,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const setBest = (term: string, score: number) => {
    const cur = out.get(term);
    if (cur === undefined || score > cur) out.set(term, score);
  };

  // 1. Exact
  const exact = await ctx.db
    .query("terms")
    .withIndex("by_collection_term", (q) =>
      q.eq("collection", collection).eq("term", token),
    )
    .unique();
  if (exact) setBest(token, EXACT);

  // 2. Prefix (last token only)
  if (isLast) {
    const rows = await ctx.db
      .query("terms")
      .withIndex("by_collection_term", (q) =>
        q.eq("collection", collection).gte("term", token).lt("term", token + HIGH),
      )
      .collect();
    for (const r of rows) setBest(r.term, PREFIX);
  }

  // 3. Fuzzy (trigram candidates + bounded Levenshtein)
  const budget = typoBudget(token.length);
  if (budget > 0) {
    const grams = trigrams(token);
    const overlap = new Map<string, number>();
    for (const gram of grams) {
      const rows = await ctx.db
        .query("trigrams")
        .withIndex("by_collection_gram", (q) =>
          q.eq("collection", collection).eq("gram", gram),
        )
        .collect();
      for (const r of rows) overlap.set(r.term, (overlap.get(r.term) ?? 0) + 1);
    }
    const threshold = Math.max(1, grams.length - budget * 3);
    for (const [term, count] of overlap) {
      if (count < threshold) continue;
      if (out.get(term) === EXACT) continue;
      const d = levenshtein(token, term, budget);
      if (d <= budget) setBest(term, typoScore(d));
    }
  }

  return out;
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run src/component/matching.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/component/matching.ts src/component/matching.test.ts
git commit -m "feat: candidate term matching (exact, prefix, fuzzy)"
```

---

## Task 6: `search.ts` — union, AND, score, sort by text_match

**Files:** Modify `src/component/search.ts`; Test `src/component/search.test.ts` (append new cases).

- [ ] **Step 1: Append failing tests to `src/component/search.test.ts`**

```ts
describe("typo-tolerant prefix search", () => {
  it("prefix matches the last token (search-as-you-type)", async () => {
    const t = await setup(); // existing setup: p1 Red Running Shoe/for runners, p2 Blue Running Jacket/rain proof, p3 Red Hat/wool
    const r = await t.query(api.search.search, { collection: "products", q: "run" });
    expect(r.found).toBe(2); // running (p1,p2) + runners (p1)
  });

  it("prefix only applies to the LAST token", async () => {
    const t = await setup();
    // "run" not last -> cannot prefix; no exact term "run"; len3 -> no fuzzy => AND fails
    expect((await t.query(api.search.search, { collection: "products", q: "run shoe" })).found).toBe(0);
    // "run" last -> prefix running/runners; "shoe" exact (p1) => AND => p1
    expect((await t.query(api.search.search, { collection: "products", q: "shoe run" })).found).toBe(1);
  });

  it("tolerates a typo within budget", async () => {
    const t = await setup();
    // "runing" (len6, budget1) ~ "running" => p1,p2
    expect((await t.query(api.search.search, { collection: "products", q: "runing" })).found).toBe(2);
  });

  it("ranks exact above prefix above typo via text_match", async () => {
    const t = await setup();
    const exact = await t.query(api.search.search, { collection: "products", q: "running" });
    expect(exact.hits[0].text_match).toBe(3);
    const prefix = await t.query(api.search.search, { collection: "products", q: "run" });
    expect(prefix.hits[0].text_match).toBe(2);
    const typo = await t.query(api.search.search, { collection: "products", q: "runing" });
    expect(typo.hits[0].text_match).toBe(1.5);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/component/search.test.ts`
Expected: FAIL — `run` currently returns 0 (no prefix), `text_match` is 0.

- [ ] **Step 3: Replace the matching/scoring section of `src/component/search.ts`**

Replace the entire file with this (keeps the envelope, clamps, match-all branch; swaps exact-only matching for the new pipeline):

```ts
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import { candidateTermsForToken } from "./matching";
import type { SearchResult, Hit } from "./types";

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
  },
  handler: async (ctx, args): Promise<SearchResult> => {
    const start = Date.now();
    await requireCollection(ctx, args.collection);

    const page = Math.max(1, Math.floor(args.page ?? 1));
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(args.perPage ?? 10)));

    const allDocs = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) => q.eq("collection", args.collection))
      .collect();
    const out_of = allDocs.length;

    const tokens = tokenize(args.q);

    let matchedIds: string[];
    let scoreById: Map<string, number> | null = null;

    if (tokens.length === 0) {
      matchedIds = allDocs.map((d) => d.docId).sort();
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
      // sort by score desc, tie-break docId asc
      matchedIds = [...scoreById.keys()].sort((a, b) => {
        const d = scoreById!.get(b)! - scoreById!.get(a)!;
        return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
      });
    }

    const found = matchedIds.length;
    const pageIds = matchedIds.slice((page - 1) * perPage, (page - 1) * perPage + perPage);

    const byId = new Map(allDocs.map((d) => [d.docId, d.stored]));
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
      facet_counts: [],
    };
  },
});
```

- [ ] **Step 4: Regenerate + run the full suite (no regressions)**

Run: `npm run build:codegen && npx vitest run`
Expected: PASS — all prior search tests still green (their assertions tolerate the new ordering), plus the 4 new typo/prefix/ranking tests. Total test count increases.

- [ ] **Step 5: Commit**

```bash
git add src/component/search.ts src/component/search.test.ts src/component/_generated
git commit -m "feat: typo+prefix matching with relevance ranking in search"
```

---

## Task 7: Verify end-to-end + update docs

**Files:** Modify `README.md`. Verify `example/` on the deployment.

- [ ] **Step 1: Deploy + smoke-test the new behavior against the live deployment**

Run from repo root:
```bash
npm run build:codegen
npx convex dev --once
npx convex run products:seed
```
Then verify (each on its own line):
```bash
npx convex run products:searchProducts '{"q":"aur"}'      # expect found 2 (prefix -> aurora)
npx convex run products:searchProducts '{"q":"aurra"}'    # expect found 2 (typo -> aurora)
npx convex run products:searchProducts '{"q":"shoo"}'     # expect found >=2 (typo -> shoe)
npx convex run products:searchProducts '{"q":"vertex bot"}' # expect found 1 (vertex + bot* prefix -> bottle)
```
Expected: all return the indicated matches; `hits[].text_match` is non-zero. If any differ, STOP and investigate (do not patch blindly).

- [ ] **Step 2: Update `README.md`**

- Move prefix matching, typo tolerance, and relevance ranking OUT of the "Phase 1 limitations" list and INTO Features, documenting: prefix on the last token (search-as-you-type), typo tolerance with per-length budget (≤3:0, 4–7:1, ≥8:2), and `text_match` relevance scoring (exact > prefix > typo).
- Keep documenting the remaining real limits: no highlighting yet, no faceting/filtering yet, hot-term postings ceiling unchanged.
- Verify every claim against the code before writing it.

- [ ] **Step 3: Final verification**

Run:
```bash
npx vitest run
npm run build
npm run typecheck
```
Expected: all tests pass; no TS errors; typecheck clean (component + example + example/convex).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document prefix + typo tolerance + ranking"
```

---

## Self-Review notes (reconciled against the spec)

- **Spec coverage:** prefix-on-last-token ✔ (Task 5 `isLast` + Task 6 last-index); trigram fuzzy + Levenshtein budget ✔ (Tasks 2,5); budget by length ✔ (Task 2 `typoBudget`); AND across tokens ✔ (Task 6 intersect); union within token ✔ (Task 6 `docScoresForToken` + Task 5 `setBest`); ranking exact>prefix>typo + `text_match` ✔ (Tasks 5,6); `terms`/`trigrams` tables ✔ (Task 3) maintained via old/new diff ✔ (Task 4 `applyTermDiff`, `clearDoc` derives oldTerms from postings); `trigrams()` helper ✔ (Task 1); synchronous writes preserved ✔ (Task 4); short-token 0-budget ✔ (Task 2); envelope unchanged, highlight/facets still placeholders ✔ (Task 6).
- **Index addition beyond spec:** `trigrams.by_collection_term` (Task 3) — needed for deletion cleanup; noted inline.
- **Type/name consistency:** `EXACT`/`PREFIX` exported from `matching.ts` and used in its test; `candidateTermsForToken(ctx, collection, token, isLast)` signature identical across Tasks 5/6; `applyTermDiff(ctx, collection, oldTerms, newTerms)` identical across Tasks 4 files; `clearDoc` returns `Set<string>`; `delete` still exported via `deleteDoc as delete`.
- **Regression guard:** Tasks 4 and 6 explicitly re-run prior test files; existing search assertions sort names or check counts, so the new ranking order does not break them.
```
