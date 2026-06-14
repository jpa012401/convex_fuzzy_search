export type Hit = {
  document: Record<string, unknown>;
  highlight: Record<string, { snippet: string; matched_tokens: string[] }>;
  text_match: number; // raw relevance score (exact>prefix>typo); 0 in browse mode
};

export type FacetCount = {
  field_name: string;
  counts: { value: string; count: number }[];
};

export type SearchResult = {
  found: number;
  found_approximate: boolean;
  page: number;
  out_of: number;
  search_time_ms: number;
  hits: Hit[];
  facet_counts: FacetCount[]; // empty in Phase 1
};
