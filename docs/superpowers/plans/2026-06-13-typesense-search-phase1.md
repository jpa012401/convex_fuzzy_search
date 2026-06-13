# Typesense-style Search Component — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a publishable Convex component providing exact tokenized full-text search (AND semantics) with Typesense-shaped output, plus a React/Vite ecommerce sample app, all TDD.

**Architecture:** A Convex component owns three tables — `collections` (config), `documents` (stored projection returned in hits), `postings` (row-per-`(term,docId,field)` inverted index). A pure tokenizer feeds both the synchronous write path (`upsert`/`delete`) and the `search` query, which intersects per-token postings sets (AND), counts `found`, paginates, and assembles the Typesense envelope. A typed client class wraps the component functions for consumers. An `example/` app demonstrates it as an ecommerce storefront.

**Tech Stack:** Convex (component API), TypeScript, `convex-test` + Vitest, React + Vite (example frontend).

**Spec:** `docs/superpowers/specs/2026-06-13-typesense-convex-phase1-design.md`

---

## File Structure

```
package.json, tsconfig.json, tsconfig.build.json   # component package (from template)
vitest.config.ts                                    # test runner
src/
  component/
    convex.config.ts        # defineComponent("typesenseSearch")
    schema.ts               # collections / documents / postings tables + indexes
    tokenizer.ts            # pure tokenize(text) -> string[]  (shared by write + search)
    collections.ts          # createCollection / getCollection / deleteCollection
    write.ts                # upsert / delete / upsertMany (synchronous indexing)
    search.ts               # search query (AND, found, pagination, envelope)
    types.ts                # shared SearchResult / Hit types
  client/
    index.ts                # TypesenseSearch class consumers import
tests/
    tokenizer.test.ts
    collections.test.ts
    write.test.ts
    search.test.ts
    isolation.test.ts
example/
  convex/
    convex.config.ts        # app.use(typesenseSearch)
    schema.ts               # (app has no own product table — component is source of truth)
    products.ts             # seed + wrapper query/mutations
  src/
    main.tsx, App.tsx, Storefront.tsx, components/*  # React + Vite storefront
  index.html, vite.config.ts, package.json
```

---

## Task 1: Scaffold component from the official template

**Files:**
- Create: whole repo skeleton via template, then trim.

- [ ] **Step 1: Initialize the component package from the official starter**

Run in the project root (`/Users/newuser/convex_component`, which already has a git repo + the `docs/` specs):

```bash
npm create convex-component@latest -- --no-git .
```

If that interactive command is unavailable or refuses a non-empty dir, fall back to cloning the template into a temp dir and copying files in (do NOT overwrite `docs/`):

```bash
npx degit get-convex/convex-component-template /tmp/cvx-tmpl
rsync -a --exclude='.git' --exclude='docs' /tmp/cvx-tmpl/ ./
```

Expected: a `package.json` with `convex`, `convex-test`, `vitest`, `typescript`; a `src/component/convex.config.ts`; a `src/client/index.ts`; an `example/` dir; a `vitest.config.ts`.

- [ ] **Step 2: Rename the component to `typesenseSearch`**

Edit `src/component/convex.config.ts` so it reads exactly:

```ts
import { defineComponent } from "convex/server";

const component = defineComponent("typesenseSearch");

export default component;
```

- [ ] **Step 3: Install and verify the toolchain builds**

Run:
```bash
npm install
npm run build 2>&1 | tail -20
```
Expected: build completes without TypeScript errors (template ships a trivial schema/function that compiles).

- [ ] **Step 4: Verify the test runner works**

Run:
```bash
npx vitest run 2>&1 | tail -20
```
Expected: vitest runs (template's example test passes, or "no tests found" — either is fine; we just confirm the runner starts).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold typesenseSearch component from template"
```

---

## Task 2: Tokenizer (pure function)

**Files:**
- Create: `src/component/tokenizer.ts`
- Test: `tests/tokenizer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tokenizer.test.ts
import { describe, it, expect } from "vitest";
import { tokenize } from "../src/component/tokenizer";

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric", () => {
    expect(tokenize("iPhone-15 Pro!")).toEqual(["iphone", "15", "pro"]);
  });

  it("handles unicode letters and digits", () => {
    expect(tokenize("Café 2024 naïve")).toEqual(["café", "2024", "naïve"]);
  });

  it("collapses repeated separators and trims", () => {
    expect(tokenize("  a,,b  c ")).toEqual(["a", "b", "c"]);
  });

  it("returns [] for empty or separator-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("  -- ,, ")).toEqual([]);
    expect(tokenize(null as unknown as string)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tokenizer.test.ts`
Expected: FAIL — cannot find module `tokenizer` / `tokenize` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/component/tokenizer.ts

// Split on anything that is NOT a Unicode letter or number, lowercase each token.
// Shared by both indexing (write.ts) and querying (search.ts) so they can never
// disagree on tokenization.
const SEPARATORS = /[^\p{L}\p{N}]+/u;

export function tokenize(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  return text
    .toLowerCase()
    .split(SEPARATORS)
    .filter((t) => t.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tokenizer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/component/tokenizer.ts tests/tokenizer.test.ts
git commit -m "feat: add pure tokenizer (lowercase + unicode alnum split)"
```

---

## Task 3: Component schema (tables + indexes)

**Files:**
- Modify/Create: `src/component/schema.ts`

- [ ] **Step 1: Write the schema**

Replace the template's `src/component/schema.ts` with:

```ts
// src/component/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  collections: defineTable({
    name: v.string(),
    searchFields: v.array(v.string()),
    // "all" stores the whole doc; otherwise an explicit projection.
    storedFields: v.union(v.literal("all"), v.array(v.string())),
  }).index("by_name", ["name"]),

  documents: defineTable({
    collection: v.string(),
    docId: v.string(),
    stored: v.any(), // projected fields returned in hits
  }).index("by_collection_doc", ["collection", "docId"]),

  postings: defineTable({
    collection: v.string(),
    term: v.string(),
    docId: v.string(),
    field: v.string(), // source field (unused Phase 1; Phase 3 ranking)
    tf: v.number(), // term frequency in that field (unused Phase 1; Phase 3)
  })
    .index("by_collection_term", ["collection", "term"])
    .index("by_collection_doc", ["collection", "docId"]),
});
```

- [ ] **Step 2: Verify it compiles / codegen runs**

Run:
```bash
npm run build 2>&1 | tail -20
```
Expected: builds; `src/component/_generated/` updates with the new tables. No TS errors.

- [ ] **Step 3: Commit**

```bash
git add src/component/schema.ts src/component/_generated
git commit -m "feat: define collections/documents/postings schema"
```

---

## Task 4: Shared result types

**Files:**
- Create: `src/component/types.ts`

- [ ] **Step 1: Write the types**

```ts
// src/component/types.ts
export type Hit = {
  document: Record<string, unknown>;
  highlight: Record<string, unknown>; // empty in Phase 1
  text_match: number; // 0 placeholder in Phase 1
};

export type FacetCount = {
  field_name: string;
  counts: { value: string; count: number }[];
};

export type SearchResult = {
  found: number;
  page: number;
  out_of: number;
  search_time_ms: number;
  hits: Hit[];
  facet_counts: FacetCount[]; // empty in Phase 1
};
```

- [ ] **Step 2: Verify compile**

Run: `npm run build 2>&1 | tail -5`
Expected: no TS errors.

- [ ] **Step 3: Commit**

```bash
git add src/component/types.ts
git commit -m "feat: add shared SearchResult/Hit types"
```

---

## Task 5: Collection management (create/get/delete)

**Files:**
- Create: `src/component/collections.ts`
- Test: `tests/collections.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/collections.test.ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../src/component/schema";
import { api } from "../src/component/_generated/api";

const modules = import.meta.glob("../src/component/**/*.ts");

describe("collections", () => {
  it("creates and reads a collection", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name", "description"],
    });
    const c = await t.query(api.collections.getCollection, { name: "products" });
    expect(c).toMatchObject({
      name: "products",
      searchFields: ["name", "description"],
      storedFields: "all",
    });
  });

  it("rejects duplicate collection names", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.collections.createCollection, {
      name: "products",
      searchFields: ["name"],
    });
    await expect(
      t.mutation(api.collections.createCollection, {
        name: "products",
        searchFields: ["name"],
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("getCollection returns null for unknown name", async () => {
    const t = convexTest(schema, modules);
    expect(
      await t.query(api.collections.getCollection, { name: "nope" }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/collections.test.ts`
Expected: FAIL — `api.collections` undefined / module missing.

- [ ] **Step 3: Write the implementation**

```ts
// src/component/collections.ts
import { mutation, query, QueryCtx } from "./_generated/server";
import { v } from "convex/values";

export async function loadCollection(ctx: QueryCtx, name: string) {
  return await ctx.db
    .query("collections")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

export async function requireCollection(ctx: QueryCtx, name: string) {
  const c = await loadCollection(ctx, name);
  if (c === null) {
    throw new Error(`CollectionNotFound: "${name}"`);
  }
  return c;
}

export const createCollection = mutation({
  args: {
    name: v.string(),
    searchFields: v.array(v.string()),
    storedFields: v.optional(
      v.union(v.literal("all"), v.array(v.string())),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await loadCollection(ctx, args.name);
    if (existing !== null) {
      throw new Error(`Collection "${args.name}" already exists`);
    }
    await ctx.db.insert("collections", {
      name: args.name,
      searchFields: args.searchFields,
      storedFields: args.storedFields ?? "all",
    });
  },
});

export const getCollection = query({
  args: { name: v.string() },
  handler: async (ctx, args) => loadCollection(ctx, args.name),
});

export const deleteCollection = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const c = await requireCollection(ctx, args.name);
    // delete all postings and documents for this collection
    for (const table of ["postings", "documents"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_collection_doc", (q) => q.eq("collection", args.name))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
    await ctx.db.delete(c._id);
  },
});
```

Note: `postings` has a `by_collection_doc` index (used here and in `delete`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/collections.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/component/collections.ts tests/collections.test.ts src/component/_generated
git commit -m "feat: collection create/get/delete with duplicate guard"
```

---

## Task 6: Write path — upsert / delete / upsertMany

**Files:**
- Create: `src/component/write.ts`
- Test: `tests/write.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/write.test.ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../src/component/schema";
import { api } from "../src/component/_generated/api";

const modules = import.meta.glob("../src/component/**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.collections.createCollection, {
    name: "products",
    searchFields: ["name", "description"],
    storedFields: ["name", "price"],
  });
  return t;
}

// helper to read raw postings for assertions
async function postingsFor(t: any, docId: string) {
  return await t.run(async (ctx: any) =>
    ctx.db
      .query("postings")
      .withIndex("by_collection_doc", (q: any) =>
        q.eq("collection", "products").eq("docId", docId),
      )
      .collect(),
  );
}

describe("write path", () => {
  it("upsert tokenizes searchFields into postings and stores projection", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "running shoe", price: 50, secret: "x" },
    });
    const postings = await postingsFor(t, "p1");
    const terms = postings.map((p: any) => p.term).sort();
    expect(terms).toEqual(["red", "running", "shoe", "shoe"].sort());
    // stored projection only keeps declared fields
    const docs = await t.run(async (ctx: any) =>
      ctx.db
        .query("documents")
        .withIndex("by_collection_doc", (q: any) =>
          q.eq("collection", "products").eq("docId", "p1"),
        )
        .unique(),
    );
    expect(docs.stored).toEqual({ name: "Red Shoe", price: 50 });
  });

  it("re-upsert replaces postings with no orphans", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "running shoe", price: 50 },
    });
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Blue Hat", description: "", price: 10 },
    });
    const terms = (await postingsFor(t, "p1")).map((p: any) => p.term).sort();
    expect(terms).toEqual(["blue", "hat"]);
  });

  it("delete removes document and all its postings", async () => {
    const t = await setup();
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "Red Shoe", description: "running shoe", price: 50 },
    });
    await t.mutation(api.write.delete, { collection: "products", id: "p1" });
    expect(await postingsFor(t, "p1")).toEqual([]);
  });

  it("upsert on unknown collection throws CollectionNotFound", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.write.upsert, { collection: "nope", id: "p1", doc: {} }),
    ).rejects.toThrow(/CollectionNotFound/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/write.test.ts`
Expected: FAIL — `api.write` missing.

- [ ] **Step 3: Write the implementation**

```ts
// src/component/write.ts
import { mutation, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";

type Doc = Record<string, unknown>;

function project(doc: Doc, storedFields: "all" | string[]): Doc {
  if (storedFields === "all") return doc;
  const out: Doc = {};
  for (const f of storedFields) {
    if (f in doc) out[f] = doc[f];
  }
  return out;
}

async function deleteDocInternal(
  ctx: MutationCtx,
  collection: string,
  docId: string,
) {
  const postings = await ctx.db
    .query("postings")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .collect();
  for (const p of postings) await ctx.db.delete(p._id);

  const existing = await ctx.db
    .query("documents")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .unique();
  if (existing) await ctx.db.delete(existing._id);
}

async function upsertInternal(
  ctx: MutationCtx,
  collection: string,
  id: string,
  doc: Doc,
) {
  const col = await requireCollection(ctx, collection);
  // replace: clear prior postings + document
  await deleteDocInternal(ctx, collection, id);

  // tokenize each search field, counting term frequency per field
  for (const field of col.searchFields) {
    const value = doc[field];
    if (typeof value !== "string") continue;
    const counts = new Map<string, number>();
    for (const term of tokenize(value)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
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
    await deleteDocInternal(ctx, args.collection, args.id);
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
```

Note on naming: the test calls `api.write.delete`. Because `delete` is a TS reserved word for a local `const`, export it under the name `delete` via the object — adjust the export line to:

```ts
export { deleteDoc as delete };
```
Add that line at the end of `write.ts` so `api.write.delete` resolves. (Keep `deleteDoc` defined as above.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/write.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/component/write.ts tests/write.test.ts src/component/_generated
git commit -m "feat: synchronous upsert/delete/upsertMany with postings + projection"
```

---

## Task 7: Search query (AND, found, pagination, envelope)

**Files:**
- Create: `src/component/search.ts`
- Test: `tests/search.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/search.test.ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../src/component/schema";
import { api } from "../src/component/_generated/api";

const modules = import.meta.glob("../src/component/**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.collections.createCollection, {
    name: "products",
    searchFields: ["name", "description"],
  });
  const items = [
    { id: "p1", doc: { name: "Red Running Shoe", description: "for runners" } },
    { id: "p2", doc: { name: "Blue Running Jacket", description: "rain proof" } },
    { id: "p3", doc: { name: "Red Hat", description: "wool" } },
  ];
  await t.mutation(api.write.upsertMany, { collection: "products", docs: items });
  return t;
}

describe("search", () => {
  it("single token returns all matches with exact found", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, { collection: "products", q: "red" });
    expect(r.found).toBe(2);
    expect(r.out_of).toBe(3);
    expect(r.hits.map((h: any) => h.document.name).sort()).toEqual([
      "Red Hat",
      "Red Running Shoe",
    ]);
  });

  it("multi token is AND (all tokens must match)", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, {
      collection: "products",
      q: "red running",
    });
    expect(r.found).toBe(1);
    expect(r.hits[0].document.name).toBe("Red Running Shoe");
  });

  it("queryBy restricts matching fields", async () => {
    const t = await setup();
    // "runners" only appears in description of p1
    const r = await t.query(api.search.search, {
      collection: "products",
      q: "runners",
      queryBy: ["name"],
    });
    expect(r.found).toBe(0);
  });

  it("empty q matches all (browsing) with pagination", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, {
      collection: "products",
      q: "",
      page: 1,
      perPage: 2,
    });
    expect(r.found).toBe(3);
    expect(r.hits.length).toBe(2);
  });

  it("no match returns found 0 and empty hits with full envelope", async () => {
    const t = await setup();
    const r = await t.query(api.search.search, { collection: "products", q: "zzz" });
    expect(r).toMatchObject({ found: 0, hits: [], facet_counts: [] });
    expect(typeof r.search_time_ms).toBe("number");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search.test.ts`
Expected: FAIL — `api.search` missing.

- [ ] **Step 3: Write the implementation**

```ts
// src/component/search.ts
import { query, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import type { SearchResult, Hit } from "./types";

const MAX_PER_PAGE = 250;

async function docIdsForToken(
  ctx: QueryCtx,
  collection: string,
  term: string,
  queryBy: string[] | undefined,
): Promise<Set<string>> {
  const rows = await ctx.db
    .query("postings")
    .withIndex("by_collection_term", (q) =>
      q.eq("collection", collection).eq("term", term),
    )
    .collect();
  const ids = new Set<string>();
  for (const r of rows) {
    if (queryBy && !queryBy.includes(r.field)) continue;
    ids.add(r.docId);
  }
  return ids;
}

function intersect(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  // start from the smallest set for efficiency
  sets.sort((a, b) => a.size - b.size);
  const [first, ...rest] = sets;
  const out = new Set<string>();
  for (const id of first) {
    if (rest.every((s) => s.has(id))) out.add(id);
  }
  return out;
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

    // total docs in collection (out_of)
    const allDocs = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) => q.eq("collection", args.collection))
      .collect();
    const out_of = allDocs.length;

    const tokens = tokenize(args.q);

    let matchedIds: string[];
    if (tokens.length === 0) {
      // match-all, stable order by docId
      matchedIds = allDocs.map((d) => d.docId);
    } else {
      const sets: Set<string>[] = [];
      for (const tok of tokens) {
        sets.push(await docIdsForToken(ctx, args.collection, tok, args.queryBy));
      }
      matchedIds = [...intersect(sets)];
    }

    matchedIds.sort(); // deterministic order (Phase 1)
    const found = matchedIds.length;

    const pageIds = matchedIds.slice((page - 1) * perPage, (page - 1) * perPage + perPage);

    // assemble hits from stored docs
    const byId = new Map(allDocs.map((d) => [d.docId, d.stored]));
    const hits: Hit[] = pageIds.map((id) => ({
      document: (byId.get(id) ?? {}) as Record<string, unknown>,
      highlight: {},
      text_match: 0,
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

Note on the `Date.now()` call: this runs inside the Convex query at runtime (allowed in deployed/`convex-test` execution); the test only asserts it is a number.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/search.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/component/search.ts tests/search.test.ts src/component/_generated
git commit -m "feat: exact AND search with found, pagination, Typesense envelope"
```

---

## Task 8: Multi-collection isolation test

**Files:**
- Test: `tests/isolation.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/isolation.test.ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../src/component/schema";
import { api } from "../src/component/_generated/api";

const modules = import.meta.glob("../src/component/**/*.ts");

describe("multi-collection isolation", () => {
  it("search in one collection never returns another's docs", async () => {
    const t = convexTest(schema, modules);
    for (const name of ["products", "articles"]) {
      await t.mutation(api.collections.createCollection, {
        name,
        searchFields: ["name"],
      });
    }
    await t.mutation(api.write.upsert, {
      collection: "products",
      id: "p1",
      doc: { name: "shoe" },
    });
    await t.mutation(api.write.upsert, {
      collection: "articles",
      id: "a1",
      doc: { name: "shoe" },
    });
    const r = await t.query(api.search.search, { collection: "products", q: "shoe" });
    expect(r.found).toBe(1);
    expect(r.out_of).toBe(1);
  });
});
```

- [ ] **Step 2: Run and verify it passes**

Run: `npx vitest run tests/isolation.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/isolation.test.ts
git commit -m "test: verify multi-collection isolation"
```

---

## Task 9: Client wrapper class

**Files:**
- Modify/Create: `src/client/index.ts`

- [ ] **Step 1: Write the client class**

Replace `src/client/index.ts` with:

```ts
// src/client/index.ts
import type {
  GenericQueryCtx,
  GenericMutationCtx,
  GenericDataModel,
} from "convex/server";
import type { api } from "../component/_generated/api";
import type { SearchResult } from "../component/types";

type RunQueryCtx = { runQuery: GenericQueryCtx<GenericDataModel>["runQuery"] };
type RunMutationCtx = RunQueryCtx & {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
};

// The installed component reference (app.components.typesenseSearch), typed.
type ComponentApi = typeof api;

export type StoredFields = "all" | string[];

export class TypesenseSearch {
  constructor(public component: ComponentApi) {}

  async createCollection(
    ctx: RunMutationCtx,
    args: { name: string; searchFields: string[]; storedFields?: StoredFields },
  ) {
    return ctx.runMutation(this.component.collections.createCollection, args);
  }

  async getCollection(ctx: RunQueryCtx, name: string) {
    return ctx.runQuery(this.component.collections.getCollection, { name });
  }

  async deleteCollection(ctx: RunMutationCtx, name: string) {
    return ctx.runMutation(this.component.collections.deleteCollection, { name });
  }

  async upsert(
    ctx: RunMutationCtx,
    args: { collection: string; id: string; doc: Record<string, unknown> },
  ) {
    return ctx.runMutation(this.component.write.upsert, args);
  }

  async upsertMany(
    ctx: RunMutationCtx,
    args: {
      collection: string;
      docs: { id: string; doc: Record<string, unknown> }[];
    },
  ) {
    return ctx.runMutation(this.component.write.upsertMany, args);
  }

  async delete(ctx: RunMutationCtx, args: { collection: string; id: string }) {
    return ctx.runMutation(this.component.write.delete, args);
  }

  async search(
    ctx: RunQueryCtx,
    args: {
      collection: string;
      q: string;
      page?: number;
      perPage?: number;
      queryBy?: string[];
    },
  ): Promise<SearchResult> {
    return ctx.runQuery(this.component.search.search, args);
  }
}

export type { SearchResult } from "../component/types";
```

- [ ] **Step 2: Verify build/typecheck**

Run: `npm run build 2>&1 | tail -20`
Expected: no TS errors. (If the template uses a different ctx-typing convention for clients, follow the template's pattern — the method bodies/`runQuery` calls stay the same.)

- [ ] **Step 3: Commit**

```bash
git add src/client/index.ts
git commit -m "feat: typed TypesenseSearch client wrapper"
```

---

## Task 10: Example backend (component installed, seed + wrappers)

**Files:**
- Modify: `example/convex/convex.config.ts`
- Create: `example/convex/products.ts`
- Modify: `example/convex/schema.ts` (empty app schema — component is source of truth)

- [ ] **Step 1: Install the component in the example app**

`example/convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import typesenseSearch from "../../src/component/convex.config";

const app = defineApp();
app.use(typesenseSearch);

export default app;
```

`example/convex/schema.ts` (app keeps no product table of its own):

```ts
import { defineSchema } from "convex/server";

export default defineSchema({});
```

- [ ] **Step 2: Write seed + wrapper functions**

`example/convex/products.ts`:

```ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { TypesenseSearch } from "../../src/client";

const search = new TypesenseSearch(components.typesenseSearch);
const COLLECTION = "products";

const SAMPLE = [
  { id: "1", name: "Aurora Running Shoe", description: "lightweight road running shoe", brand: "Aurora", category: "Shoes", price: 89, image: "https://picsum.photos/seed/1/300" },
  { id: "2", name: "Aurora Trail Shoe", description: "grippy off-road trail shoe", brand: "Aurora", category: "Shoes", price: 109, image: "https://picsum.photos/seed/2/300" },
  { id: "3", name: "Nimbus Rain Jacket", description: "waterproof breathable jacket", brand: "Nimbus", category: "Outerwear", price: 149, image: "https://picsum.photos/seed/3/300" },
  { id: "4", name: "Nimbus Wool Hat", description: "warm merino wool hat", brand: "Nimbus", category: "Accessories", price: 29, image: "https://picsum.photos/seed/4/300" },
  { id: "5", name: "Vertex Yoga Mat", description: "non slip cushioned yoga mat", brand: "Vertex", category: "Fitness", price: 39, image: "https://picsum.photos/seed/5/300" },
  { id: "6", name: "Vertex Water Bottle", description: "insulated stainless steel bottle", brand: "Vertex", category: "Fitness", price: 25, image: "https://picsum.photos/seed/6/300" },
];

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await search.getCollection(ctx, COLLECTION);
    if (!existing) {
      await search.createCollection(ctx, {
        name: COLLECTION,
        searchFields: ["name", "description", "brand", "category"],
        storedFields: "all",
      });
    }
    await search.upsertMany(ctx, {
      collection: COLLECTION,
      docs: SAMPLE.map(({ id, ...rest }) => ({ id, doc: { id, ...rest } })),
    });
    return { seeded: SAMPLE.length };
  },
});

export const searchProducts = query({
  args: {
    q: v.string(),
    page: v.optional(v.number()),
    perPage: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    search.search(ctx, { collection: COLLECTION, ...args }),
});
```

- [ ] **Step 3: Run the example backend and seed**

Run (in `example/`, requires a Convex dev login or `--once` with a configured deployment):
```bash
cd example && npx convex dev --once 2>&1 | tail -20
```
Expected: functions deploy without errors. Then seed:
```bash
npx convex run products:seed 2>&1 | tail -5
```
Expected: `{ seeded: 6 }`.

- [ ] **Step 4: Smoke-test search from CLI**

Run:
```bash
npx convex run products:searchProducts '{"q":"aurora shoe"}' 2>&1 | tail -20
```
Expected: `found: 2`, hits are the two Aurora shoes.

- [ ] **Step 5: Commit**

```bash
cd .. && git add example/convex && git commit -m "feat: example backend installing component with seed + search wrappers"
```

---

## Task 11: Example frontend — ecommerce storefront

**Files:**
- Create: `example/src/Storefront.tsx`, `example/src/components/SearchBar.tsx`, `example/src/components/ProductGrid.tsx`, `example/src/components/FacetSidebar.tsx`
- Modify: `example/src/App.tsx` (template usually provides main.tsx + ConvexProvider)

- [ ] **Step 1: Build the storefront component**

`example/src/Storefront.tsx`:

```tsx
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { SearchBar } from "./components/SearchBar";
import { ProductGrid } from "./components/ProductGrid";
import { FacetSidebar } from "./components/FacetSidebar";

const PER_PAGE = 4;

export function Storefront() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const seed = useMutation(api.products.seed);
  const result = useQuery(api.products.searchProducts, { q, page, perPage: PER_PAGE });

  const totalPages = result ? Math.max(1, Math.ceil(result.found / PER_PAGE)) : 1;

  return (
    <div style={{ display: "flex", gap: 24, padding: 24, fontFamily: "system-ui" }}>
      <FacetSidebar />
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

`example/src/components/SearchBar.tsx`:

```tsx
export function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      placeholder="Search products…"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ flex: 1, padding: 8, fontSize: 16 }}
    />
  );
}
```

`example/src/components/ProductGrid.tsx`:

```tsx
type Hit = { document: Record<string, any> };

export function ProductGrid({ hits }: { hits: Hit[] }) {
  if (hits.length === 0) return <p>No products found.</p>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 16 }}>
      {hits.map((h) => (
        <div key={h.document.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <img src={h.document.image} alt={h.document.name} style={{ width: "100%", borderRadius: 4 }} />
          <div style={{ fontWeight: 600 }}>{h.document.name}</div>
          <div style={{ color: "#666", fontSize: 13 }}>{h.document.brand}</div>
          <div>${h.document.price}</div>
        </div>
      ))}
    </div>
  );
}
```

`example/src/components/FacetSidebar.tsx` (disabled placeholder for Phase 2/3):

```tsx
export function FacetSidebar() {
  return (
    <aside style={{ width: 200, opacity: 0.5 }}>
      <h3>Filters</h3>
      <p style={{ fontSize: 12 }}>Brand, category, price — <em>coming in Phase 2</em></p>
      <h3>Sort</h3>
      <select disabled>
        <option>Relevance (Phase 3)</option>
      </select>
    </aside>
  );
}
```

- [ ] **Step 2: Wire Storefront into App**

Edit `example/src/App.tsx` so its body renders `<Storefront />` (keep the template's `ConvexProvider`/`ConvexReactClient` setup):

```tsx
import { Storefront } from "./Storefront";

export default function App() {
  return <Storefront />;
}
```

- [ ] **Step 3: Run the frontend and smoke-test manually**

Run (two terminals): `cd example && npx convex dev` and `cd example && npm run dev`.
Open the printed localhost URL. Click **Seed data**. Type "aurora" → expect the two Aurora products and "2 results". Clear the box → all 6 with pagination across 2 pages.

- [ ] **Step 4: Commit**

```bash
git add example/src && git commit -m "feat: ecommerce storefront demo UI (Phase 1 scope)"
```

---

## Task 12: README + final verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write a README** documenting install, `createCollection`, `upsert`, `search`, the Typesense-shaped output, and the Phase 1 limits (no typo/facets/filter/ranking; bounded scale). Include the client usage snippet from Task 10.

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run 2>&1 | tail -30`
Expected: all tests pass (tokenizer 4, collections 3, write 4, search 5, isolation 1).

- [ ] **Step 3: Typecheck/build the whole package**

Run: `npm run build 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add README.md && git commit -m "docs: Phase 1 README"
```

---

## Self-Review notes (already reconciled)

- **Spec coverage:** collections config ✔ (Task 5), configurable projection ✔ (Task 6 `project`), consumer id + upsert ✔ (Task 6), synchronous indexing ✔ (Task 6), tokenizer rules ✔ (Task 2), AND match + exact tokens ✔ (Task 7), `queryBy` via `field` column ✔ (Task 7), match-all empty q ✔ (Task 7), envelope shape ✔ (Task 7 + Task 4 types), error handling (CollectionNotFound, duplicate, perPage clamp) ✔ (Tasks 5–7), multi-collection isolation ✔ (Task 8), sample ecommerce app ✔ (Tasks 10–11), smoke check ✔ (Task 11 Step 3).
- **Naming consistency:** `delete` exported via `deleteDoc as delete`; client `search`/`upsert`/`delete` call matching `api.*` paths; `by_collection_doc` index exists on both `postings` and `documents`.
- **Known deferrals:** `facet_counts`/`highlight`/`text_match` are placeholders by spec design; hot-term read ceiling is Phase 4.
```
