import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
      v.array(
        v.array(
          v.object({
            field: v.string(),
            order: v.union(v.literal("asc"), v.literal("desc")),
          }),
        ),
      ),
    ),
    rankProfiles: v.optional(v.record(v.string(), rankProfileValidator)),
    pendingFields: v.optional(v.array(v.string())),
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
});
