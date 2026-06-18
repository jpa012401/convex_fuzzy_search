export type Hit = {
  id: string;
  score: number; // raw relevance score (exact>prefix>typo); 0 in browse mode
  highlight: Record<string, { snippet: string; matched_tokens: string[] }>;
};

export type FacetCount = {
  field_name: string;
  counts: { value: string; count: number }[];
};

export type SearchResult = {
  found: number;
  found_approximate: boolean;
  reranked: boolean;
  page: number;
  out_of: number;
  hits: Hit[];
  facet_counts: FacetCount[]; // per-field value tallies; empty unless facetBy is requested
};
