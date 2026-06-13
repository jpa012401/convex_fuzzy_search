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
