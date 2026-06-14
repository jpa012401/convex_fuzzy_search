export type Hit = {
  document: Record<string, unknown>;
  highlight: Record<string, { snippet: string; matched_tokens: string[] }>;
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
