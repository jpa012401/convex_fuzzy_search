type FilterField = { field: string; type: "string" | "number" };
type SortKey = { field: string; order: "asc" | "desc" };
export type CollectionConfig = {
  searchFields: string[];
  storedFields: "all" | "derived" | string[];
  filterFields?: FilterField[];
  facetFields?: string[];
  sortSpecs?: SortKey[][];
  rankProfiles?: Record<string, { base: string; window?: number; terms: unknown[] }>;
};

export type CollectionDiff =
  | { kind: "create"; pendingFields: string[] }
  | { kind: "update"; pendingFields: string[] }
  | { kind: "noop"; pendingFields: [] };

// Fields newly indexed by a structural role (filter/facet/sort) require existing
// docs to be reindexed -> "pending". Search-field and rankProfile changes are
// metadata-only. Removals are lazy.
export function diffCollection(stored: CollectionConfig | null, config: CollectionConfig): CollectionDiff {
  if (stored === null) {
    return { kind: "create", pendingFields: structuralFields(config) };
  }
  const before = new Set(structuralFields(stored));
  const added = structuralFields(config).filter((f) => !before.has(f));
  return { kind: "update", pendingFields: added };
}

function structuralFields(c: CollectionConfig): string[] {
  const set = new Set<string>();
  for (const f of c.filterFields ?? []) set.add(f.field);
  for (const f of c.facetFields ?? []) set.add(f);
  for (const spec of c.sortSpecs ?? []) for (const k of spec) set.add(k.field);
  return [...set];
}
