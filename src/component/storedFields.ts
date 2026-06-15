import type { RankTerm } from "./schema";

type CollectionConfig = {
  searchFields: string[];
  filterFields?: { field: string; type: "string" | "number" }[];
  facetFields?: string[];
  sortSpecs?: { field: string; order: "asc" | "desc" }[][];
  rankProfiles?: Record<string, { base: string; window?: number; terms: RankTerm[] }>;
};

// The union of every field any index role references. This is exactly the set
// the component must persist per doc to index, filter, sort, and re-rank.
export function indexRelevantFields(c: CollectionConfig): string[] {
  const set = new Set<string>();
  for (const f of c.searchFields) set.add(f);
  for (const f of c.filterFields ?? []) set.add(f.field);
  for (const f of c.facetFields ?? []) set.add(f);
  for (const spec of c.sortSpecs ?? []) for (const k of spec) set.add(k.field);
  for (const profile of Object.values(c.rankProfiles ?? {})) {
    for (const term of profile.terms) {
      if (term.type === "geoDistance") { set.add(term.latField); set.add(term.lngField); }
      else if (term.type === "relevance") { /* no field */ }
      else set.add(term.field);
    }
  }
  return [...set];
}
