import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { SearchBar } from "./components/SearchBar";
import { ProductGrid } from "./components/ProductGrid";
import { FacetSidebar } from "./components/FacetSidebar";

const PER_PAGE = 4;

const SORTS = {
  relevance: undefined,
  "price-asc": [{ field: "price", order: "asc" as const }],
  "price-desc": [{ field: "price", order: "desc" as const }],
};
type SortKeyName = keyof typeof SORTS;

function buildFilterBy(selected: Record<string, string[]>): string | undefined {
  const clauses: string[] = [];
  for (const [field, values] of Object.entries(selected)) {
    if (values.length === 0) continue;
    clauses.push(values.length === 1 ? `${field}:${values[0]}` : `${field}:[${values.join(",")}]`);
  }
  return clauses.length ? clauses.join(" && ") : undefined;
}

export function Storefront() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [sort, setSort] = useState<SortKeyName>("relevance");
  const seed = useMutation(api.products.seed);

  const filterBy = buildFilterBy(selected);
  const result = useQuery(api.products.searchProducts, {
    q,
    page,
    perPage: PER_PAGE,
    filterBy,
    facetBy: ["brand", "category"],
    sortBy: SORTS[sort],
  });

  const totalPages = result ? Math.max(1, Math.ceil(result.found / PER_PAGE)) : 1;

  const onToggle = (field: string, value: string) => {
    setPage(1);
    setSelected((prev) => {
      const cur = prev[field] ?? [];
      const nextVals = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
      return { ...prev, [field]: nextVals };
    });
  };

  return (
    <div style={{ display: "flex", gap: 24, padding: 24, fontFamily: "system-ui" }}>
      <FacetSidebar facets={result?.facet_counts ?? []} selected={selected} onToggle={onToggle} />
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <SearchBar value={q} onChange={(v) => { setQ(v); setPage(1); }} />
          <select value={sort} onChange={(e) => { setSort(e.target.value as SortKeyName); setPage(1); }}>
            <option value="relevance">Relevance</option>
            <option value="price-asc">Price ↑</option>
            <option value="price-desc">Price ↓</option>
          </select>
          <button onClick={() => seed()}>Seed data</button>
        </div>
        <p>{result ? `${result.found} results` : "Loading…"}</p>
        <ProductGrid hits={result?.hits ?? []} />
        <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span>Page {page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}
