import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import type { Infer } from "convex/values";

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

export const sortKeyValidator = v.object({
  field: v.string(),
  order: v.union(v.literal("asc"), v.literal("desc")),
});

export const sortSpecValidator = v.array(sortKeyValidator);

// Persisted on the collection row: deterministic field-name -> slot mapping.
export const slotMapValidator = v.object({
  search: v.record(v.string(), v.string()), // fieldName -> "textN"
  strFilter: v.record(v.string(), v.string()), // fieldName -> "filtN"
  numFilter: v.record(v.string(), v.string()), // fieldName -> "numFN"
});

export type RankTerm = Infer<typeof rankTermValidator>;
export type RankProfile = Infer<typeof rankProfileValidator>;

// Shared declarative collection config shape. Reused as the `config` arg of
// configSync.applyCollectionConfig so the validator is not duplicated.
export const collectionConfigValidator = v.object({
  name: v.string(),
  searchFields: v.array(v.string()),
  // "all" stores the whole doc; "derived" the index-relevant projection; or an explicit list.
  storedFields: v.optional(
    v.union(v.literal("all"), v.literal("derived"), v.array(v.string())),
  ),
  filterFields: v.optional(
    v.array(
      v.object({
        field: v.string(),
        type: v.union(v.literal("string"), v.literal("number")),
      }),
    ),
  ),
  facetFields: v.optional(v.array(v.string())),
  sortSpecs: v.optional(
    v.array(sortSpecValidator),
  ),
  rankProfiles: v.optional(v.record(v.string(), rankProfileValidator)),
});

export const collectionDocValidator = v.object({
  _id: v.id("collections"),
  _creationTime: v.number(),
  name: v.string(),
  searchFields: v.array(v.string()),
  storedFields: v.union(v.literal("all"), v.literal("derived"), v.array(v.string())),
  filterFields: v.optional(
    v.array(
      v.object({
        field: v.string(),
        type: v.union(v.literal("string"), v.literal("number")),
      }),
    ),
  ),
  facetFields: v.optional(v.array(v.string())),
  sortSpecs: v.optional(
    v.array(sortSpecValidator),
  ),
  rankProfiles: v.optional(v.record(v.string(), rankProfileValidator)),
  pendingFields: v.optional(v.array(v.string())),
  slotMap: v.optional(slotMapValidator),
});

export const hitValidator = v.object({
  id: v.string(),
  score: v.number(),
  highlight: v.record(
    v.string(),
    v.object({ snippet: v.string(), matched_tokens: v.array(v.string()) }),
  ),
});

export const facetCountValidator = v.object({
  field_name: v.string(),
  counts: v.array(v.object({ value: v.string(), count: v.number() })),
});

// The single shared filterFields array spread into every searchDocs search
// index so the nine indexes cannot drift. collection is always present so a
// search is .eq("collection", name)-scoped (multi-tenant on one table).
export const FILTER_SLOTS = [
  "collection",
  "filt0", "filt1", "filt2", "filt3", "filt4", "filt5", "filt6", "filt7",
  "numF0", "numF1", "numF2", "numF3", "numF4", "numF5", "numF6",
] as const;
// NOTE: Convex caps a search index at 16 filterFields. FILTER_SLOTS holds
// collection(1) + filt0..7(8) + numF0..6(7) = 16 — the hard maximum.

export const searchResultValidator = v.object({
  found: v.number(),
  found_approximate: v.boolean(),
  reranked: v.boolean(),
  page: v.number(),
  out_of: v.number(),
  hits: v.array(hitValidator),
  facet_counts: v.array(facetCountValidator),
});

export const statsResultValidator = v.object({
  out_of: v.number(),
  facets: v.array(
    v.object({
      field: v.string(),
      distinctValues: v.number(),
      total: v.number(),
      truncated: v.boolean(),
    }),
  ),
  sortSpecs: v.array(v.object({ specId: v.string(), count: v.number() })),
});

export default defineSchema({
  collections: defineTable({
    name: v.string(),
    searchFields: v.array(v.string()),
    // "all" stores the whole doc; otherwise an explicit projection.
    storedFields: v.union(v.literal("all"), v.literal("derived"), v.array(v.string())),
    filterFields: v.optional(
      v.array(
        v.object({
          field: v.string(),
          type: v.union(v.literal("string"), v.literal("number")),
        }),
      ),
    ),
    facetFields: v.optional(v.array(v.string())),
    sortSpecs: v.optional(
      v.array(sortSpecValidator),
    ),
    rankProfiles: v.optional(v.record(v.string(), rankProfileValidator)),
    pendingFields: v.optional(v.array(v.string())),
    slotMap: v.optional(slotMapValidator),
  }).index("by_name", ["name"]),

  deletions: defineTable({
    name: v.string(),
    sortSpecs: v.array(sortSpecValidator),
  }).index("by_name", ["name"]),

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
    numF4: v.optional(v.number()),
    numF5: v.optional(v.number()),
    numF6: v.optional(v.number()),
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

  facetCounts: defineTable({
    collection: v.string(),
    field: v.string(),
    value: v.string(),
    count: v.number(), // # docs in the collection whose stored `field` stringifies to `value`
  })
    .index("by_field", ["collection", "field"]) // enumerate all values for a field
    .index("by_value", ["collection", "field", "value"]), // locate the row to ++/--

  // Vocabulary-scale trigram dictionary for typo correction (suggest-then-search).
  // terms: ref-counted per (collection, term); docCount tracks how many docs contain the term.
  // trigrams: one row per (collection, gram, term) for O(grams) query-time lookup.
  terms: defineTable({
    collection: v.string(),
    term: v.string(),
    docCount: v.number(),
  }).index("by_collection_term", ["collection", "term"]),

  trigrams: defineTable({
    collection: v.string(),
    gram: v.string(),
    term: v.string(),
  })
    .index("by_collection_gram", ["collection", "gram"])
    .index("by_collection_term", ["collection", "term"]),

});
