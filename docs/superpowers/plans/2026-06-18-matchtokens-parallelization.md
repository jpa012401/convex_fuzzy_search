# matchTokens Parallelization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parallelize the sequential verify loop in `matchTokens` so text-search queries issue their per-doc reads in two `Promise.all` batches instead of one serial loop — with zero behavior change.

**Architecture:** Replace the single `for…of`-with-`await` loop in `src/component/textSearch.ts` (lines 96–117) with two phases: Phase A `Promise.all`s the `loadDocTerms` reads and verifies in memory; Phase B `Promise.all`s the `loadDocumentByDocKey` reads for passing docs only. Read count (D + P) and result ordering are preserved exactly.

**Tech Stack:** TypeScript, Convex components, vitest + convex-test (`npm test` = `vitest run --typecheck`). Cloud dev deployment `perfect-lion-433` (alias `dev`) for the benchmark.

## Global Constraints

- **Zero behavior change.** `matchTokens` keeps its exact signature and return type. For every query, the resulting `scoreById` (keys, values, insertion order), `matchedTerms`, `truncated`, and `singleExactTerm` must be identical to the current implementation.
- **Read count unchanged.** D `loadDocTerms` reads (multi-token only) + P `loadDocumentByDocKey` reads (passing docs only), where D = driver match count, P = passing count. No extra reads — the 4096-reads-per-query budget exposure must not grow.
- Full suite green: `npm test` = 211+ passing (210 existing + 1 new), 0 type errors. Whole-project `npm run typecheck` clean.
- Spec: `docs/superpowers/specs/2026-06-18-matchtokens-parallelization-design.md`.
- Cloud benchmark runs on the **dev** deployment only (`--deployment dev`). Never `--prod`. No re-seed.

---

### Task 0: Create the working branch

**Files:** none (git only)

- [ ] **Step 1: Branch off main**

```bash
git checkout main
git checkout -b perf/matchtokens-parallel
git status
```
Expected: `On branch perf/matchtokens-parallel`, clean tree.

---

### Task 1: Add a focused regression test for the passing-set resolution

**Files:**
- Test: `src/component/textSearch.test.ts` (add one `it(...)` inside the existing `describe("matchTokens", …)`)

**Interfaces:**
- Consumes: `matchTokens(ctx, collection, tokens, queryBy)` from `src/component/textSearch.ts` — returns `{ scoreById: Map<string, number>, matchedTerms: Set<string>, truncated: boolean, singleExactTerm: string | null }`. Test calls it inside `t.run(async (ctx) => …)` and serializes the Map to entries (Maps don't cross the convex-test boundary directly), mirroring the existing tests in this file.
- Produces: nothing (test only).

This test pins the one property a parallelization bug could break: that only
driver docs which PASS the non-driver-token check appear in results (the old
code's early-exit behavior). It must pass on the CURRENT code too (it documents
existing behavior), so it is a regression guard, not red-then-green.

- [ ] **Step 1: Add the test**

Add this `it(...)` block inside `describe("matchTokens", …)` in `src/component/textSearch.test.ts` (after the existing "multi-term AND" test):

```ts
  it("multi-term AND excludes driver docs that fail the other-token check", async () => {
    // "leather" is the rare/driver token (1 doc: "3"). "shoe" is common (all 3).
    // Doc 3 contains both -> passes. Build a case where a driver-token doc lacks
    // the other token so it must be excluded from the resolved result set.
    const t = convexTest(schema, modules);
    registerAggregate(t, "docCount");
    await t.mutation(api.collections.createCollection, {
      name: "shop2",
      searchFields: ["name"],
      storedFields: "all",
    });
    // "gadget" is common (3 docs) so it is NOT the driver; "rare" is selective
    // (2 docs: a, b) so it drives. Doc "a" is driver-matched on "rare" but lacks
    // "gadget" -> must be excluded by the verify step. Doc "c" never enters the
    // driver set. Only "b" has both.
    const docs = [
      { id: "a", doc: { name: "rare gizmo" } },     // has "rare", NOT "gadget"
      { id: "b", doc: { name: "rare gadget" } },    // has both -> the only match
      { id: "c", doc: { name: "common gadget" } },  // has "gadget", NOT "rare"
      { id: "d", doc: { name: "plain gadget" } },   // has "gadget", NOT "rare"
    ];
    for (const d of docs) await t.mutation(api.write.upsert, { collection: "shop2", ...d });

    const r = await t.run(async (ctx: any) => {
      const res = await matchTokens(ctx, "shop2", ["rare", "gadget"], undefined);
      return { keys: [...res.scoreById.keys()].sort(), entries: [...res.scoreById.entries()] };
    });
    // "gadget" has docCount 3 (b,c,d), "rare" has docCount 2 (a,b) -> "rare"
    // drives. Driver-matched docs are {a, b}; "a" fails the "gadget" check and
    // must be excluded. Only "b" has BOTH tokens.
    expect(r.keys).toEqual(["b"]);
    expect(new Map(r.entries as [string, number][]).get("b")).toBe(6); // exact(3)+exact(3)
  });
```

- [ ] **Step 2: Run the test against current code (must pass)**

Run: `npx vitest run --typecheck src/component/textSearch.test.ts`
Expected: all tests PASS (including the new one — it documents existing behavior). If the new test FAILS on current code, STOP and report — the premise is wrong.

- [ ] **Step 3: Commit**

```bash
git add src/component/textSearch.test.ts
git commit -m "test: pin matchTokens excludes driver docs failing the other-token check"
```

---

### Task 2: Parallelize the verify loop

**Files:**
- Modify: `src/component/textSearch.ts:94-117` (the verify loop)

**Interfaces:**
- Consumes: `loadDocTerms(ctx, collection, docKey): Promise<DocTerm[]>` and `loadDocumentByDocKey(ctx, collection, docKey): Promise<Doc<"documents"> | null>` (already imported in this file). `bestScore(present, candidates)` helper (already defined above the loop). `driverScore: Map<number, number>`, `others: { candidates: Candidates }[]`, `queryBy: string[] | undefined` (all already in scope).
- Produces: unchanged `matchTokens` return value.

- [ ] **Step 1: Replace the sequential loop with two parallel phases**

In `src/component/textSearch.ts`, replace this block (the current lines 94–117):

```ts
  const others = perToken.filter((_, i) => i !== driverIdx);
  const scoreById = new Map<string, number>();
  for (const [docKey, dScore] of driverScore) {
    let present: Map<string, number> | null = null;
    if (others.length > 0) {
      const postings = await loadDocTerms(ctx, collection, docKey);
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
    if (ok) {
      const doc = await loadDocumentByDocKey(ctx, collection, docKey);
      if (doc) scoreById.set(doc.docId, total);
    }
  }

  return { scoreById, matchedTerms, truncated, singleExactTerm };
```

with:

```ts
  const others = perToken.filter((_, i) => i !== driverIdx);
  const driverDocs = [...driverScore]; // [docKey, dScore] in driverScore order

  // Phase A — gather + verify. For multi-token queries, read each driver doc's
  // terms ONCE (in parallel), then verify the non-driver tokens purely in
  // memory. Single-token queries (others.length === 0) skip the read entirely:
  // every driver doc passes with total = dScore, exactly as before.
  const termsByIndex =
    others.length > 0
      ? await Promise.all(driverDocs.map(([docKey]) => loadDocTerms(ctx, collection, docKey)))
      : [];

  // Passing docs, in driverScore order, with their blended score.
  const passing: { docKey: number; total: number }[] = [];
  for (let i = 0; i < driverDocs.length; i++) {
    const [docKey, dScore] = driverDocs[i];
    let present: Map<string, number> | null = null;
    if (others.length > 0) {
      present = new Map<string, number>();
      for (const p of termsByIndex[i]) {
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
    if (ok) passing.push({ docKey, total });
  }

  // Phase B — resolve docIds for the passing docs ONLY (same read set as the
  // old early-exit), in parallel. Build scoreById in passing (driverScore)
  // order so insertion order is unchanged.
  const docs = await Promise.all(
    passing.map((p) => loadDocumentByDocKey(ctx, collection, p.docKey)),
  );
  const scoreById = new Map<string, number>();
  for (let i = 0; i < passing.length; i++) {
    const doc = docs[i];
    if (doc) scoreById.set(doc.docId, passing[i].total);
  }

  return { scoreById, matchedTerms, truncated, singleExactTerm };
```

- [ ] **Step 2: Run the matchTokens + search suites**

Run: `npx vitest run --typecheck src/component/textSearch.test.ts src/component/search.test.ts src/component/matching.test.ts src/component/fuzzy.test.ts`
Expected: all pass, no type errors. These pin multi-token AND, prefix, typo, queryBy restriction, truncation, and the new exclusion test — the full behavior-preservation net.

- [ ] **Step 3: Run the full suite + whole-project typecheck**

Run: `npm test`
Expected: `Tests 211 passed` (210 + 1 new), 0 type errors.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/component/textSearch.ts
git commit -m "perf: parallelize matchTokens verify loop (two Promise.all phases)"
```

---

### Task 3: Measure the speedup on cloud dev

**Files:** none (deploy + benchmark; record results in this plan's checkbox notes and the final report)

**Interfaces:**
- Consumes: `products:benchmark` action (example app) — returns `[{ label, found, ms, top }]`. The example app's default deployment is cloud dev `perfect-lion-433`.

The user authorized a cloud **dev** deploy for this measurement. Do NOT deploy to prod. Do NOT re-seed (the 5k data is already present; `indexStats` should report `out_of: 5000`).

- [ ] **Step 1: Capture the BEFORE baseline (current main, already deployed)**

The baseline is the spec's recorded table (multi-term 892ms, plain 800ms, prefix 781ms, typo 707ms). If you want a fresh baseline, check out main and run:

Run: `npx convex run products:benchmark '{}' --deployment dev`
Record the four text-case `ms` values.

- [ ] **Step 2: Deploy the branch to cloud dev**

From the branch `perf/matchtokens-parallel`:

Run: `npx convex dev --once --deployment dev`
Expected: deploy succeeds, no function errors.

- [ ] **Step 3: Confirm data intact**

Run: `npx convex run products:indexStats '{}' --deployment dev`
Expected: `out_of: 5000`, facets/sortSpecs totals all 5000.

- [ ] **Step 4: Capture the AFTER benchmark**

Run: `npx convex run products:benchmark '{}' --deployment dev`
Expected: the four text cases (`multi-term AND`, `plain term`, `prefix (as-you-type)`, `typo tolerance`) are materially faster than baseline, with **identical `found` and `top`** per case (proof of no behavior change at scale).

- [ ] **Step 5: Record the before/after table**

Write a `## Benchmark results` section into this plan file (or the SDD report) with a row per text case: label, found, before-ms, after-ms, top-before, top-after. Confirm `found` and `top` match before/after for every case. If any `found` or `top` differs, STOP — that is a behavior regression, not a speedup; revert and investigate.

- [ ] **Step 6: Restore main on the example deployment after measurement**

So the shared dev deployment isn't left on an unmerged branch longer than needed, note in the report that main should be re-deployed after merge (Task 4). No commit in this task.

---

### Task 4: Merge

**Files:** none (git)

- [ ] **Step 1: Final gates**

Run: `npm test`
Expected: 211 passed, 0 type errors.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Merge to main and clean up**

```bash
git checkout main
git merge --ff-only perf/matchtokens-parallel
git branch -d perf/matchtokens-parallel
git log --oneline -5
```
Expected: fast-forward merge, branch deleted.

- [ ] **Step 3: Re-deploy main to cloud dev**

Run: `npx convex dev --once --deployment dev`
Expected: dev deployment now runs the merged main. (Leaves the shared deployment on the canonical branch.)

---

## Notes for the implementer

- `npm test` = `vitest run --typecheck` (behavioral tests + typecheck of test files). `npm run typecheck` is the separate whole-project pass; run it where the plan says.
- Maps don't serialize across the convex-test `t.run` boundary — return `[...map.entries()]` and rebuild, as the existing `textSearch.test.ts` tests do.
- The two phases must preserve `driverScore` iteration order: `driverDocs = [...driverScore]` once, and Phase B iterates `passing` (built in that order). Do not sort.
- Do not push to origin; the user merges/pushes. Cloud deploys are `--deployment dev` only.
