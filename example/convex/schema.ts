import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The app stores only the editable personalization profile; product data lives
// in the FuzzySearch component. A single "default" row holds the demo profile.
export default defineSchema({
  profiles: defineTable({
    key: v.string(),
    preferredCategories: v.array(v.string()),
    preferredBrands: v.array(v.string()),
    pastSearchTerms: v.array(v.string()),
  }).index("by_key", ["key"]),
  // The app owns the serving copy of products; the component holds only the index.
  productDocs: defineTable({ docId: v.string(), doc: v.any() }).index("by_docId", ["docId"]),
  placeDocs: defineTable({ docId: v.string(), doc: v.any() }).index("by_docId", ["docId"]),
});
