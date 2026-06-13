import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { SearchBar } from "./components/SearchBar";
import { ProductGrid } from "./components/ProductGrid";
import { FacetSidebar } from "./components/FacetSidebar";

const PER_PAGE = 4;

export function Storefront() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const seed = useMutation(api.products.seed);
  const result = useQuery(api.products.searchProducts, { q, page, perPage: PER_PAGE });

  const totalPages = result ? Math.max(1, Math.ceil(result.found / PER_PAGE)) : 1;

  return (
    <div style={{ display: "flex", gap: 24, padding: 24, fontFamily: "system-ui" }}>
      <FacetSidebar />
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <SearchBar value={q} onChange={(v) => { setQ(v); setPage(1); }} />
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
