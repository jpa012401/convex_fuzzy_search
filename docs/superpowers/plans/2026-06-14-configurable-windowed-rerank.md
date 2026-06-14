# Configurable Windowed Re-Rank (Ranking Profiles) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add declared ranking profiles + a query-time scoring DSL that soft-re-orders a bounded candidate window (top-N off a base sort, or the matched set) by a weighted blend of typed terms (field / flag / setBoost / recencyDecay / geoDistance / relevance), driven by per-query context and weight overrides.

**Architecture:** A pure `score.ts` module evaluates the typed terms. Collections declare `rankProfiles` (validated against `sortSpecs` + `storedFields`). `search` gains a `rank` arg; when present it builds a bounded candidate set (a batched window off the profile's base sortSpec for browse, or the existing matched set for text/filter — capped), scores each doc with `evalTerms`, sorts by score, and pages it. A new `reranked` boolean reports whether the page came from the re-ranked window. `rank` takes precedence over `sortBy`/`rankBy`.

**Tech Stack:** Convex component (TypeScript), `@convex-dev/aggregate` (`iter` for the batched window read), `convex-test` + `vitest`.

**Spec:** `docs/superpowers/specs/2026-06-14-configurable-windowed-rerank-design.md`

**Conventions (read first):**
- `verbatimModuleSyntax` on → `import type` for type-only imports.
- Tests calling `api.write.*`/`api.search.*` register the aggregates: `registerAggregate(t, "docCount")` and, when the collection declares `sortSpecs`, `registerAggregate(t, "sortIndex")` (import `register as registerAggregate` from `@convex-dev/aggregate/test`).
- Run one test file: `npx vitest run src/component/<file>`. All: `npx vitest run`. Build/codegen/typecheck: `npm run build`.
- `numField(stored, field)` is exported from `ranking.ts` (`Number(...)`, NaN/missing → 0).
- `canonicalSpecId(spec)` and the sort aggregate live in `sortIndex.ts`.
- `rankProfiles` reference a declared `sortSpec` by its canonical id (e.g. `"postedAt:desc"`); sort fields are numeric.

---

### Task 1: `score.ts` — typed scoring DSL (pure)

**Files:**
- Create: `src/component/score.ts`
- Create: `src/component/score.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/component/score.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evalTerms, haversineKm, recencyDecay, type RankTerm } from "./score";

describe("score DSL", () => {
  it("field term = weight * numField", () => {
    const terms: RankTerm[] = [{ id: "p", type: "field", weight: 2, field: "popularity" }];
    expect(evalTerms({ popularity: 5 }, terms, undefined, 0, {})).toBe(10);
    expect(evalTerms({}, terms, undefined, 0, {})).toBe(0); // missing -> 0
  });

  it("flag term: truthy, and equals", () => {
    const t1: RankTerm[] = [{ id: "f", type: "flag", weight: 3, field: "partnered" }];
    expect(evalTerms({ partnered: true }, t1, undefined, 0, {})).toBe(3);
    expect(evalTerms({ partnered: "true" }, t1, undefined, 0, {})).toBe(3);
    expect(evalTerms({ partnered: false }, t1, undefined, 0, {})).toBe(0);
    const t2: RankTerm[] = [{ id: "f", type: "flag", weight: 3, field: "tier", equals: "gold" }];
    expect(evalTerms({ tier: "gold" }, t2, undefined, 0, {})).toBe(3);
    expect(evalTerms({ tier: "silver" }, t2, undefined, 0, {})).toBe(0);
  });

  it("setBoost term: membership via context.sets[setKey]", () => {
    const terms: RankTerm[] = [{ id: "s", type: "setBoost", weight: 1.5, field: "category", setKey: "prefCats" }];
    const ctx = { sets: { prefCats: ["Eng", "Design"] } };
    expect(evalTerms({ category: "Eng" }, terms, undefined, 0, ctx)).toBe(1.5);
    expect(evalTerms({ category: "Sales" }, terms, undefined, 0, ctx)).toBe(0);
    expect(evalTerms({ category: "Eng" }, terms, undefined, 0, {})).toBe(0); // no set in context -> 0
  });

  it("recencyDecay: half-life and future-clamp", () => {
    expect(recencyDecay(0, 1000)).toBe(1);
    expect(recencyDecay(1000, 1000)).toBeCloseTo(0.5, 5);
    expect(recencyDecay(2000, 1000)).toBeCloseTo(0.25, 5);
    expect(recencyDecay(-500, 1000)).toBe(1); // future -> clamp age 0
    const terms: RankTerm[] = [{ id: "r", type: "recencyDecay", weight: 4, field: "postedAt", halfLifeMs: 1000 }];
    expect(evalTerms({ postedAt: 9000 }, terms, undefined, 0, { now: 10000 })).toBeCloseTo(4 * 0.5, 5);
    expect(evalTerms({ postedAt: 9000 }, terms, undefined, 0, {})).toBe(0); // no now -> 0
  });

  it("geoDistance: haversine + maxKm clamp + missing coords", () => {
    expect(haversineKm(0, 0, 0, 0)).toBe(0);
    expect(haversineKm(40.0, -74.0, 40.0, -74.0)).toBe(0);
    const terms: RankTerm[] = [{ id: "g", type: "geoDistance", weight: 2, latField: "lat", lngField: "lng", maxKm: 100 }];
    const here = { origin: { lat: 40.0, lng: -74.0 } };
    expect(evalTerms({ lat: 40.0, lng: -74.0 }, terms, undefined, 0, here)).toBe(2); // dist 0 -> full
    expect(evalTerms({ lat: 80.0, lng: -74.0 }, terms, undefined, 0, here)).toBe(0); // far (>100km) -> 0
    expect(evalTerms({}, terms, undefined, 0, here)).toBe(0); // no coords -> 0
    expect(evalTerms({ lat: 40, lng: -74 }, terms, undefined, 0, {})).toBe(0); // no origin -> 0
  });

  it("relevance term = weight * textMatch", () => {
    const terms: RankTerm[] = [{ id: "rel", type: "relevance", weight: 2 }];
    expect(evalTerms({}, terms, undefined, 3, {})).toBe(6);
    expect(evalTerms({}, terms, undefined, 0, {})).toBe(0);
  });

  it("evalTerms sums terms and applies per-id weight overrides", () => {
    const terms: RankTerm[] = [
      { id: "p", type: "field", weight: 1, field: "popularity" },
      { id: "f", type: "flag", weight: 3, field: "partnered" },
    ];
    expect(evalTerms({ popularity: 10, partnered: true }, terms, undefined, 0, {})).toBe(13);
    // override "f" weight to 0:
    expect(evalTerms({ popularity: 10, partnered: true }, terms, { f: 0 }, 0, {})).toBe(10);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/component/score.test.ts`
Expected: FAIL — `./score` does not exist.

- [ ] **Step 3: Implement `src/component/score.ts`**

```ts
import { numField } from "./ranking";

export type RankContext = {
  now?: number;
  origin?: { lat: number; lng: number };
  sets?: Record<string, string[]>;
};

export type RankTerm =
  | { id: string; type: "field"; weight: number; field: string }
  | { id: string; type: "flag"; weight: number; field: string; equals?: string }
  | { id: string; type: "setBoost"; weight: number; field: string; setKey: string }
  | { id: string; type: "recencyDecay"; weight: number; field: string; halfLifeMs: number }
  | { id: string; type: "geoDistance"; weight: number; latField: string; lngField: string; maxKm: number }
  | { id: string; type: "relevance"; weight: number };

const EARTH_KM = 6371;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 2^(-age/halfLife); future (negative age) clamps to 1.
export function recencyDecay(ageMs: number, halfLifeMs: number): number {
  return Math.pow(2, -Math.max(0, ageMs) / halfLifeMs);
}

function coord(stored: Record<string, unknown>, field: string): number | null {
  const raw = stored[field];
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function contribution(
  term: RankTerm,
  weight: number,
  stored: Record<string, unknown>,
  textMatch: number,
  context: RankContext,
): number {
  switch (term.type) {
    case "field":
      return weight * numField(stored, term.field);
    case "flag": {
      const v = stored[term.field];
      const on =
        term.equals !== undefined
          ? String(v) === String(term.equals)
          : v === true || v === 1 || v === "true";
      return on ? weight : 0;
    }
    case "setBoost": {
      const set = context.sets?.[term.setKey];
      if (!set) return 0;
      return set.includes(String(stored[term.field])) ? weight : 0;
    }
    case "recencyDecay": {
      if (context.now === undefined) return 0;
      return weight * recencyDecay(context.now - numField(stored, term.field), term.halfLifeMs);
    }
    case "geoDistance": {
      if (!context.origin) return 0;
      const lat = coord(stored, term.latField);
      const lng = coord(stored, term.lngField);
      if (lat === null || lng === null) return 0;
      const d = haversineKm(context.origin.lat, context.origin.lng, lat, lng);
      return weight * Math.max(0, 1 - d / term.maxKm);
    }
    case "relevance":
      return weight * textMatch;
  }
}

// Weighted blend of terms for one document. `weights` overrides a term's weight
// by id; `textMatch` is the doc's raw relevance score (0 in browse).
export function evalTerms(
  stored: Record<string, unknown>,
  terms: RankTerm[],
  weights: Record<string, number> | undefined,
  textMatch: number,
  context: RankContext,
): number {
  let sum = 0;
  for (const term of terms) {
    const w = weights?.[term.id];
    sum += contribution(term, w === undefined ? term.weight : w, stored, textMatch, context);
  }
  return sum;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/component/score.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/component/score.ts src/component/score.test.ts
git commit -m "feat(rank): score.ts — typed scoring DSL (field/flag/setBoost/recency/geo/relevance)"
```

---

### Task 2: `rankProfiles` config + validation

**Files:**
- Modify: `src/component/schema.ts` (validators + column)
- Modify: `src/component/collections.ts` (arg + validation + persist)
- Create: `src/component/rankProfiles.test.ts`

- [ ] **Step 1: Add validators + column to `schema.ts`**

In `src/component/schema.ts`, before `export default defineSchema({`, add the shared validators:

```ts
export const rankTermValidator = v.union(
  v.object({ id: v.string(), type: v.literal("field"), weight: v.number(), field: v.string() }),
  v.object({ id: v.string(), type: v.literal("flag"), weight: v.number(), field: v.string(), equals: v.optional(v.string()) }),
  v.object({ id: v.string(), type: v.literal("setBoost"), weight: v.number(), field: v.string(), setKey: v.string() }),
  v.object({ id: v.string(), type: v.literal("recencyDecay"), weight: v.number(), field: v.string(), halfLifeMs: v.number() }),
  v.object({ id: v.string(), type: v.literal("geoDistance"), weight: v.number(), latField: v.string(), lngField: v.string(), maxKm: v.number() }),
  v.object({ id: v.string(), type: v.literal("relevance"), weight: v.number() }),
);

export const rankProfileValidator = v.object({
  base: v.string(),
  window: v.optional(v.number()),
  terms: v.array(rankTermValidator),
});
```

Then add the column to the `collections` table, immediately after the `sortSpecs` field:

```ts
    rankProfiles: v.optional(v.record(v.string(), rankProfileValidator)),
```

- [ ] **Step 2: Write the failing validation test**

Create `src/component/rankProfiles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

function t() {
  const c = convexTest(schema, modules);
  registerAggregate(c, "docCount");
  registerAggregate(c, "sortIndex");
  return c;
}

const base = {
  name: "jobs",
  searchFields: ["title"],
  storedFields: ["title", "partnered", "postedAt", "lat", "lng", "category"] as string[],
  sortSpecs: [[{ field: "postedAt", order: "desc" as const }]],
};

describe("rankProfiles validation at createCollection", () => {
  it("accepts a valid profile", async () => {
    const c = t();
    await c.mutation(api.collections.createCollection, {
      ...base,
      rankProfiles: {
        jobsFeed: {
          base: "postedAt:desc",
          window: 300,
          terms: [
            { id: "partner", type: "flag", weight: 3, field: "partnered" },
            { id: "fresh", type: "recencyDecay", weight: 2, field: "postedAt", halfLifeMs: 6.048e8 },
            { id: "near", type: "geoDistance", weight: 2, latField: "lat", lngField: "lng", maxKm: 50 },
            { id: "pref", type: "setBoost", weight: 1.5, field: "category", setKey: "prefCats" },
          ],
        },
      },
    });
    const col = await c.query(api.collections.getCollection, { name: "jobs" });
    expect(col?.rankProfiles?.jobsFeed.base).toBe("postedAt:desc");
  });

  it("rejects a base that is not a declared sortSpec", async () => {
    const c = t();
    await expect(
      c.mutation(api.collections.createCollection, {
        ...base,
        rankProfiles: { p: { base: "price:asc", terms: [] } },
      }),
    ).rejects.toThrow(/base/);
  });

  it("rejects a term field not in storedFields", async () => {
    const c = t();
    await expect(
      c.mutation(api.collections.createCollection, {
        ...base,
        rankProfiles: { p: { base: "postedAt:desc", terms: [{ id: "x", type: "field", weight: 1, field: "salary" }] } },
      }),
    ).rejects.toThrow(/storedFields/);
  });

  it("rejects duplicate term ids", async () => {
    const c = t();
    await expect(
      c.mutation(api.collections.createCollection, {
        ...base,
        rankProfiles: { p: { base: "postedAt:desc", terms: [
          { id: "a", type: "flag", weight: 1, field: "partnered" },
          { id: "a", type: "field", weight: 1, field: "postedAt" },
        ] } },
      }),
    ).rejects.toThrow(/duplicate/i);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/component/rankProfiles.test.ts`
Expected: FAIL — `createCollection` does not accept/validate `rankProfiles` yet.

- [ ] **Step 4: Implement in `collections.ts`**

(a) Add an import at the top:

```ts
import { canonicalSpecId } from "./sortIndex";
import { rankProfileValidator } from "./schema";
```

(b) In the `createCollection` mutation `args`, after the `sortSpecs` validator, add:

```ts
    rankProfiles: v.optional(v.record(v.string(), rankProfileValidator)),
```

(c) Inside the handler, after the existing `if (storedFields !== "all") { ... }` validation block (and after `const storedFields = ...`), add profile validation. It needs the set of declared sortSpec canonical ids and (when projecting) the persisted field set:

```ts
    if (args.rankProfiles) {
      const specIds = new Set((args.sortSpecs ?? []).map((s) => canonicalSpecId(s)));
      const persisted = storedFields === "all" ? null : new Set(storedFields);
      const fieldOk = (f: string) => persisted === null || persisted.has(f);
      for (const [name, profile] of Object.entries(args.rankProfiles)) {
        if (!specIds.has(profile.base)) {
          throw new Error(`rankProfile "${name}" base "${profile.base}" must be a declared sortSpec`);
        }
        const seen = new Set<string>();
        for (const term of profile.terms) {
          if (seen.has(term.id)) throw new Error(`rankProfile "${name}" has duplicate term id "${term.id}"`);
          seen.add(term.id);
          const fields =
            term.type === "geoDistance" ? [term.latField, term.lngField]
            : term.type === "relevance" ? []
            : [term.field];
          for (const f of fields) {
            if (!fieldOk(f)) {
              throw new Error(`rankProfile "${name}" term "${term.id}" field "${f}" must be included in storedFields`);
            }
          }
        }
      }
    }
```

(d) In the `ctx.db.insert("collections", { ... })` call, after `sortSpecs: args.sortSpecs,`, add:

```ts
      rankProfiles: args.rankProfiles,
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/component/rankProfiles.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Build + full suite**

Run: `npm run build && npx vitest run`
Expected: build clean; all green.

- [ ] **Step 7: Commit**

```bash
git add src/component/schema.ts src/component/collections.ts src/component/rankProfiles.test.ts
git commit -m "feat(rank): rankProfiles config + createCollection validation"
```

---

### Task 3: Batched window read on the sort index

**Files:**
- Modify: `src/component/sortIndex.ts`
- Modify: `src/component/sort-write.test.ts` (add a test)

- [ ] **Step 1: Add the failing test**

Append inside the existing `describe("write path maintains sort index", ...)` block in `src/component/sort-write.test.ts` (before its closing `});`):

```ts
  it("pageSortedDocIdsRange reads the first N in base order in one batched scan", async () => {
    const t = await setup();
    for (let i = 0; i < 6; i++) {
      await t.mutation(api.write.upsert, { collection: "shop", id: `p${i}`, doc: { name: `p${i}`, price: i * 10 } });
    }
    const ids = await t.run((ctx: any) => pageSortedDocIdsRange(ctx, "shop", "price:asc", 4));
    expect(ids).toEqual(["p0", "p1", "p2", "p3"]); // cheapest 4, in order
    const all = await t.run((ctx: any) => pageSortedDocIdsRange(ctx, "shop", "price:asc", 100));
    expect(all.length).toBe(6); // limit beyond size returns all
  });
```

Add `pageSortedDocIdsRange` to the import at the top of `sort-write.test.ts`:

```ts
import { pageSortedDocIds, pageSortedDocIdsRange } from "./sortIndex";
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/component/sort-write.test.ts`
Expected: FAIL — `pageSortedDocIdsRange` does not exist.

- [ ] **Step 3: Implement in `sortIndex.ts`**

Add after `pageSortedDocIds`:

```ts
// First `limit` docIds of a spec namespace in base order, read as a SINGLE
// batched range scan (aggregate `iter` with internal paging) — not `limit`
// separate `at()` calls. Used to retrieve a re-rank window cheaply.
export async function pageSortedDocIdsRange(
  ctx: QueryCtx,
  collection: string,
  specId: string,
  limit: number,
): Promise<string[]> {
  const namespace = ns(collection, specId);
  const ids: string[] = [];
  for await (const item of sortAgg.iter(ctx, { namespace, order: "asc", pageSize: 200 })) {
    ids.push(item.id);
    if (ids.length >= limit) break;
  }
  return ids;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/component/sort-write.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/component/sortIndex.ts src/component/sort-write.test.ts
git commit -m "feat(rank): batched window read pageSortedDocIdsRange (iter, not per-item at)"
```

---

### Task 4: Search integration — `rank` path + `reranked`

**Files:**
- Modify: `src/component/types.ts`
- Modify: `src/component/search.ts`
- Create: `src/component/rank-search.test.ts`

**Context:** the `search` handler (post-S5) computes `hasFilter/hasFacets/hasSortBy/hasRankBy/hasCustomOrder`, has three lean early-returns (browse / browse+facets / browse+sort), then builds the working set (`matchedIds`, `byId`, `scoreById`) in a `tokens>0 / filterIds / else(full-load)` chain, computes `found`, sorts via `orderScore`+`compareMatches`, tallies facets in-memory, and pages. This task inserts a `rank` path.

- [ ] **Step 1: Add `reranked` to the result type**

In `src/component/types.ts`, add to `SearchResult` after `found_approximate`:

```ts
  reranked: boolean;
```

- [ ] **Step 2: Write the failing test**

Create `src/component/rank-search.test.ts`:

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
const ids = (r: any) => r.hits.map((h: any) => h.document.id);

describe("rank profiles re-rank a browse window", () => {
  it("partnered flag (huge weight) floats an old job to the top despite base=newest", async () => {
    const { c, now } = await seeded();
    const r = await c.query(api.search.search, {
      collection: "jobs", q: "",
      rank: { profile: "feed", context: { now } },
    });
    expect(ids(r)[0]).toBe("old-partner");
    expect(r.found).toBe(3);          // soft re-order: membership unchanged
    expect(r.out_of).toBe(3);
    expect(r.reranked).toBe(true);
  });

  it("setBoost via context floats preferred-category jobs", async () => {
    const { c, now } = await seeded();
    const r = await c.query(api.search.search, {
      collection: "jobs", q: "",
      rank: { profile: "feed", weights: { partner: 0 }, context: { now, sets: { prefCats: ["Eng"] } } },
    });
    // partner weight 0; Eng jobs (old-partner, old-plain) boosted above new-plain (Sales)
    expect(ids(r).slice(0, 2).sort()).toEqual(["old-partner", "old-plain"]);
    expect(ids(r)[2]).toBe("new-plain");
  });

  it("text query: relevance term blends; found is the matched count", async () => {
    const { c, now } = await seeded();
    const r = await c.query(api.search.search, {
      collection: "jobs", q: "engineer",
      rank: { profile: "feed", weights: { rel: 0, fresh: 0, pref: 0 }, context: { now } },
    });
    expect(r.found).toBe(3);                 // all three match "engineer"
    expect(ids(r)[0]).toBe("old-partner");   // partner flag dominates
    expect(r.reranked).toBe(true);
  });

  it("unknown profile throws", async () => {
    const { c } = await seeded();
    await expect(
      c.query(api.search.search, { collection: "jobs", q: "", rank: { profile: "nope" } }),
    ).rejects.toThrow(/rank profile/i);
  });

  it("non-rank queries report reranked: true", async () => {
    const { c } = await seeded();
    const r = await c.query(api.search.search, { collection: "jobs", q: "" });
    expect(r.reranked).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/component/rank-search.test.ts`
Expected: FAIL — `rank` arg unsupported / `reranked` missing.

- [ ] **Step 4: Implement in `search.ts`**

(a) Add imports:

```ts
import { specMatches, canonicalSpecId, pageSortedDocIds, pageSortedDocIdsRange } from "./sortIndex";
import { evalTerms } from "./score";
```
(the existing `specMatches, canonicalSpecId, pageSortedDocIds` import line gains `pageSortedDocIdsRange`; add the `evalTerms` import alongside the other `./` imports.)

(b) Add module constants near `MAX_PER_PAGE`:

```ts
const DEFAULT_RERANK_WINDOW = 200;
const MAX_RERANK_WINDOW = 1000;
```

(c) Add the `rank` arg to the `search` `args` validator (after `sortBy`):

```ts
    rank: v.optional(
      v.object({
        profile: v.string(),
        weights: v.optional(v.record(v.string(), v.number())),
        context: v.optional(
          v.object({
            now: v.optional(v.number()),
            origin: v.optional(v.object({ lat: v.number(), lng: v.number() })),
            sets: v.optional(v.record(v.string(), v.array(v.string()))),
          }),
        ),
      }),
    ),
```

(d) Resolve the profile right after the `hasCustomOrder` line, and fold it into `hasCustomOrder` so the lean early-returns don't fire for rank queries:

```ts
    const rankProfile = args.rank ? collection.rankProfiles?.[args.rank.profile] : undefined;
    if (args.rank && !rankProfile) {
      throw new Error(`Unknown rank profile "${args.rank.profile}"`);
    }
    const hasRank = !!rankProfile;
```
Then change the `hasCustomOrder` definition to include `hasRank`:

```ts
    const hasCustomOrder = hasSortBy || hasRankBy || hasRank;
```

(e) In the working-set chain, add a rank-browse branch **before** the final `else` (full-load). The chain is `if (tokens.length > 0) {…} else if (filterIds) {…} else {…full-load…}`. Insert between the `filterIds` branch and the `else`:

```ts
    } else if (hasRank) {
      // RANK BROWSE: candidate window off the profile's base sortSpec (batched).
      const windowSize = Math.min(MAX_RERANK_WINDOW, Math.max(1, Math.floor(rankProfile!.window ?? DEFAULT_RERANK_WINDOW)));
      matchedIds = await pageSortedDocIdsRange(ctx, args.collection, rankProfile!.base, windowSize);
      byId = await loadDocs(ctx, args.collection, matchedIds);
    } else {
```

(f) Add `reranked` (default true) next to the `truncated`/`singleExactTerm` declarations:

```ts
    let reranked = true;
```

(g) Replace the existing ordering block — find:

```ts
    const rawScore = (id: string) => (scoreById ? (scoreById.get(id) ?? 0) : 0);
    const orderScore = (id: string) => orderingScore(rawScore(id), storedOf(id), args.rankBy);
    matchedIds.sort((a, b) =>
      compareMatches(a, b, { score: orderScore, stored: storedOf, sortBy: args.sortBy }),
    );
```

with a branch on `hasRank`:

```ts
    const rawScore = (id: string) => (scoreById ? (scoreById.get(id) ?? 0) : 0);
    if (hasRank) {
      const isBrowse = tokens.length === 0 && !filterIds;
      const windowSize = Math.min(MAX_RERANK_WINDOW, Math.max(1, Math.floor(rankProfile!.window ?? DEFAULT_RERANK_WINDOW)));
      // Establish candidate order before windowing: browse = base order (already),
      // text = relevance desc, filter-only = arbitrary (the matched set order).
      let ordered = matchedIds;
      if (tokens.length > 0) {
        ordered = [...matchedIds].sort((a, b) => rawScore(b) - rawScore(a) || (a < b ? -1 : a > b ? 1 : 0));
      }
      if (ordered.length > windowSize) {
        ordered = ordered.slice(0, windowSize);
        reranked = false; // capped: not the full intended set
      }
      const baseIdx = new Map(ordered.map((id, i) => [id, i]));
      const ctxRank = args.rank!.context ?? {};
      const score = (id: string) =>
        evalTerms(storedOf(id), rankProfile!.terms, args.rank!.weights, rawScore(id), ctxRank);
      matchedIds = [...ordered].sort((a, b) => score(b) - score(a) || (baseIdx.get(a)! - baseIdx.get(b)!));
    } else {
      const orderScore = (id: string) => orderingScore(rawScore(id), storedOf(id), args.rankBy);
      matchedIds.sort((a, b) =>
        compareMatches(a, b, { score: orderScore, stored: storedOf, sortBy: args.sortBy }),
      );
    }
```

(h) Fix `found` for rank-browse (soft re-order → whole collection is the result). Find the `let found = matchedIds.length;` block and, immediately after the `if (truncated) { ... }` block that follows it, add:

```ts
    if (hasRank && tokens.length === 0 && !filterIds) {
      found = out_of;
    }
```

(i) Tail-page fallback + facets-from-counters for rank-browse. Locate the facet section and the pagination near the end of the handler:

```ts
    const pageIds = matchedIds.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
```

Replace that single line with:

```ts
    const start = (page - 1) * perPage;
    const windowSize = Math.min(MAX_RERANK_WINDOW, Math.max(1, Math.floor(rankProfile?.window ?? DEFAULT_RERANK_WINDOW)));
    let pageIds: string[];
    if (hasRank && tokens.length === 0 && !filterIds && start >= windowSize) {
      // Beyond the re-ranked window: serve the plain base order (head-only re-rank).
      pageIds = await pageSortedDocIds(ctx, args.collection, rankProfile!.base, start, perPage);
      const tailById = await loadDocs(ctx, args.collection, pageIds);
      for (const [k, val] of tailById) byId.set(k, val);
      reranked = false;
    } else {
      pageIds = matchedIds.slice(start, start + perPage);
    }
```

(j) For rank-browse, facets should be global (from S3 counters), not over the window. In the facet section, change the guard so a rank-browse uses counters. Replace the facet block's opening:

```ts
    const facet_counts: FacetCount[] = [];
    if (hasFacets) {
      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
      for (const field of args.facetBy as string[]) {
        if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
        const tally = new Map<string, number>();
```

with:

```ts
    const facet_counts: FacetCount[] = [];
    if (hasFacets) {
      const declared = new Set(collection.facetFields ?? []);
      const maxValues = Math.max(0, Math.floor(args.maxFacetValues ?? 10));
      const globalFacets = hasRank && tokens.length === 0 && !filterIds; // browse rank -> counters
      for (const field of args.facetBy as string[]) {
        if (!declared.has(field)) throw new Error(`Field "${field}" is not a declared facet field`);
        if (globalFacets) {
          facet_counts.push({ field_name: field, counts: await readFacetCounts(ctx, args.collection, field, maxValues) });
          continue;
        }
        const tally = new Map<string, number>();
```

(`readFacetCounts` is already imported.)

(k) Add `reranked` to **every** `return { ... }` in the handler: the three lean early-returns (`reranked: true`), and the final return. The final return currently is:

```ts
    return { found, found_approximate, page, out_of, search_time_ms: Date.now() - start, hits, facet_counts };
```
becomes:
```ts
    return { found, found_approximate, reranked, page, out_of, search_time_ms: Date.now() - start, hits, facet_counts };
```
And in each of the three lean returns, insert `reranked: true,` after `found_approximate: false,`.

(l) Precedence: `rank` overrides `sortBy`/`rankBy`. Because the ordering block branches on `hasRank` first (step g) and the lean-sort early-return requires `hasSortBy && !hasRankBy` but `hasCustomOrder` now includes `hasRank`, a query with both `rank` and `sortBy` skips the lean-sort path and is ordered by the rank block. No extra code needed — but add a guard so a `rank` + `sortBy` query does not also try the lean browse+sort early-return: that return is guarded by `tokens.length === 0 && !hasFilter && hasSortBy && !hasRankBy`. Add `&& !hasRank` to it:

```ts
    if (tokens.length === 0 && !hasFilter && hasSortBy && !hasRankBy && !hasRank) {
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/component/rank-search.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Build + full suite**

Run: `npm run build && npx vitest run`
Expected: build clean; all green. Existing `search.test.ts`/`sort-search.test.ts`/`facet-search.test.ts` now also carry `reranked: true` (their asserts don't check it, so they pass).

- [ ] **Step 7: Commit**

```bash
git add src/component/types.ts src/component/search.ts src/component/rank-search.test.ts
git commit -m "feat(rank): windowed re-rank in search (rank arg, candidate window, reranked flag, precedence)"
```

---

### Task 5: Client + example

**Files:**
- Modify: `src/client/index.ts` (createCollection type + `rank` arg type)
- Modify: `example/convex/products.ts` (declare a rank profile + pass `rank`)

- [ ] **Step 1: Extend the client types**

In `src/client/index.ts`:

(a) In `createCollection`'s `args` type, after `sortSpecs?: …`, add:

```ts
      rankProfiles?: Record<string, {
        base: string;
        window?: number;
        terms: Array<
          | { id: string; type: "field"; weight: number; field: string }
          | { id: string; type: "flag"; weight: number; field: string; equals?: string }
          | { id: string; type: "setBoost"; weight: number; field: string; setKey: string }
          | { id: string; type: "recencyDecay"; weight: number; field: string; halfLifeMs: number }
          | { id: string; type: "geoDistance"; weight: number; latField: string; lngField: string; maxKm: number }
          | { id: string; type: "relevance"; weight: number }
        >;
      }>;
```

(b) In the `search` method's `args` type, after `sortBy?: …`, add:

```ts
      rank?: {
        profile: string;
        weights?: Record<string, number>;
        context?: { now?: number; origin?: { lat: number; lng: number }; sets?: Record<string, string[]> };
      };
```

- [ ] **Step 2: Declare a profile + expose it in the example**

In `example/convex/products.ts`:

(a) After `SORT_SPECS`, add a profile that boosts popularity + the user's preferred categories over a recency base (the products dataset has `popularity`, `affinity`, `category`, and per-category `cat_<Category>` fields; use `postedAt`-equivalent `releasedDaysAgo` is *ascending* recency, so use a `popularity`-desc base if no timestamp — declare a sortSpec for it):

```ts
// A rank profile for the storefront: boost popular + affinity + preferred
// categories, re-ranking a window taken off the popularity base order.
export const RANK_PROFILES = {
  boosted: {
    base: "popularity:desc",
    window: 200,
    terms: [
      { id: "pop", type: "field" as const, weight: 0.001, field: "popularity" },
      { id: "aff", type: "field" as const, weight: 1, field: "affinity" },
      { id: "pref", type: "setBoost" as const, weight: 5, field: "category", setKey: "prefCats" },
    ],
  },
};
```

(b) Add `popularity:desc` to `SORT_SPECS` (the profile's base must be a declared sortSpec):

```ts
export const SORT_SPECS = [
  [{ field: "price", order: "asc" as const }],
  [{ field: "price", order: "desc" as const }],
  [{ field: "popularity", order: "desc" as const }],
];
```

(c) In `createProductsCollection`, add to the `createCollection` call (after `sortSpecs: SORT_SPECS,`):

```ts
    rankProfiles: RANK_PROFILES,
```

(d) Add `rank` to the `searchProducts` query args validator (after `rankBy`) and pass it through:

```ts
    rank: v.optional(
      v.object({
        profile: v.string(),
        weights: v.optional(v.record(v.string(), v.number())),
        context: v.optional(
          v.object({
            now: v.optional(v.number()),
            origin: v.optional(v.object({ lat: v.number(), lng: v.number() })),
            sets: v.optional(v.record(v.string(), v.array(v.string()))),
          }),
        ),
      }),
    ),
```

(The handler already spreads `...args` into `search.search`, so `rank` flows through with no handler change. Verify the handler is `search.search(ctx, { collection: COLLECTION, ...args })`; if it lists fields explicitly, add `rank: args.rank`.)

- [ ] **Step 3: Typecheck + full suite**

Run: `npm run build && npx vitest run`
Expected: build/typecheck clean (component + client); all tests green.

- [ ] **Step 4: Commit**

```bash
git add src/client/index.ts example/convex/products.ts
git commit -m "feat(rank): client types + example rank profile (boosted browse)"
```

---

## Self-Review

**1. Spec coverage:**
- Term DSL (field/flag/setBoost/recencyDecay/geoDistance/relevance) + haversine + decay → Task 1. ✓
- `rankProfiles` declared on collection + validation (base ∈ sortSpecs, fields ∈ storedFields, duplicate ids, param requirements via validator) → Task 2. ✓
- `reranked` envelope field → Task 4 Step 1/k. ✓
- Batched window read (no per-item `at()`) → Task 3. ✓
- `rank` arg (profile + weights + context) → Task 4 Step 4c. ✓
- Candidate set: browse window (Task 4e) / text relevance-order cap / filter-only cap (Task 4g) → ✓
- Scoring + sort + tie-break by base/relevance index → Task 4g. ✓
- `found` = out_of for rank-browse → Task 4h. ✓
- Tail-page fallback to base order + `reranked:false` → Task 4i. ✓
- Facets from counters for rank-browse → Task 4j. ✓
- Precedence over sortBy/rankBy → Task 4d (hasCustomOrder), 4g (branch), 4l (lean-sort guard). ✓
- Client + example → Task 5. ✓

**2. Placeholder scan:** none — full code in every step.

**3. Type consistency:**
- `RankTerm`/`RankContext` defined in `score.ts` (Task 1), matched by the schema validators (Task 2) and client types (Task 5) field-for-field; `evalTerms(stored, terms, weights, textMatch, context)` signature identical across definition (T1) and call (T4g).
- `rankProfileValidator` defined in `schema.ts` (T2 S1), imported in `collections.ts` (T2 S4a).
- `pageSortedDocIdsRange(ctx, collection, specId, limit)` defined T3, called T4e.
- `canonicalSpecId` reused for base validation (T2) — same canonical form profiles reference.
- `reranked` present on `SearchResult` (T4 S1) and set at all four returns (T4k).

## Notes for the executor
- Tasks are dependency-ordered: score → config → window read → search → client/example.
- Do NOT change the in-memory `rankBy`/`sortBy` ordering for non-rank queries — only branch on `hasRank`.
- The rank-browse window read MUST use `pageSortedDocIdsRange` (batched `iter`), never a `pageSortedDocIds` loop — that's the whole point of the perf note in the spec.
- Live 5k verification is user-run (the dev backend may be up); the test suite is the gate.
