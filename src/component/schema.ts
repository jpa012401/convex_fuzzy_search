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
  facetPostings: v.array(
    v.object({
      field: v.string(),
      totalDocKeys: v.number(),
      distinctValues: v.number(),
    }),
  ),
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
  }).index("by_name", ["name"]),

  deletions: defineTable({
    name: v.string(),
    sortSpecs: v.array(sortSpecValidator),
  }).index("by_name", ["name"]),

  documents: defineTable({
    collection: v.string(),
    docId: v.string(),
    docKey: v.number(),
    stored: v.any(), // projected fields returned in hits
  })
    .index("by_collection_doc", ["collection", "docId"])
    .index("by_collection_docKey", ["collection", "docKey"]),

  docKeyCounters: defineTable({
    collection: v.string(),
    nextDocKey: v.number(),
  }).index("by_collection", ["collection"]),

  docTerms: defineTable({
    collection: v.string(),
    docKey: v.number(),
    terms: v.array(
      v.object({
        term: v.string(),
        field: v.string(),
        tf: v.number(),
      }),
    ),
  }).index("by_collection_docKey", ["collection", "docKey"]),

  postingChunks: defineTable({
    collection: v.string(),
    term: v.string(),
    bucket: v.number(),
    entries: v.array(
      v.object({
        docKey: v.number(),
        field: v.string(),
        tf: v.number(),
      }),
    ),
  })
    .index("by_collection_term", ["collection", "term"])
    .index("by_collection_term_bucket", ["collection", "term", "bucket"]),

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

  filters: defineTable({
    collection: v.string(),
    field: v.string(),
    docId: v.string(),
    docKey: v.optional(v.number()),
    strVal: v.optional(v.string()),
    numVal: v.optional(v.number()),
  })
    .index("by_str", ["collection", "field", "strVal"])
    .index("by_num", ["collection", "field", "numVal"])
    .index("by_doc", ["collection", "docId"]),

  facetCounts: defineTable({
    collection: v.string(),
    field: v.string(),
    value: v.string(),
    count: v.number(), // # docs in the collection whose stored `field` stringifies to `value`
  })
    .index("by_field", ["collection", "field"]) // enumerate all values for a field
    .index("by_value", ["collection", "field", "value"]), // locate the row to ++/--

  facetPostings: defineTable({
    collection: v.string(),
    field: v.string(),
    value: v.string(),
    bucket: v.number(),
    docKeys: v.array(v.number()),
  })
    .index("by_collection_field_value", ["collection", "field", "value"])
    .index("by_collection_field_value_bucket", ["collection", "field", "value", "bucket"]),
});
