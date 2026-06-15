import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { SearchBar } from "./components/SearchBar";
import { ProductGrid } from "./components/ProductGrid";

type SortKey = { field: string; order: "asc" | "desc" };
const SORT_FIELDS = ["price", "rating", "popularity", "releasedDaysAgo"];

export function RankingLab() {
  // Lazy initial state: Date.now() runs once at mount (not during render).
  const [now] = useState(() => Date.now());
  const [q, setQ] = useState("");
  const [useFresh, setUseFresh] = useState(true);
  const [recencyW, setRecencyW] = useState(5);
  const [relW, setRelW] = useState(1);
  const [sortKeys, setSortKeys] = useState<SortKey[]>([]);

  const rank = useFresh
    ? { profile: "fresh", weights: { recency: recencyW, rel: relW }, context: { now } }
    : undefined;
  const sortBy = sortKeys.length && !useFresh ? sortKeys : undefined;

  const result = useQuery(api.products.searchProducts, { q, perPage: 12, rank, sortBy });

  return (
    <div style={{ padding: 16 }}>
      <h2>Ranking Lab</h2>
      <p style={{ color: "#666", marginTop: 0 }}>
        Demonstrates the <code>fresh</code> recencyDecay profile, the <code>relevance</code> term, and multi-key sort.
      </p>
      <SearchBar value={q} onChange={setQ} />
      <div style={{ display: "flex", gap: 16, alignItems: "center", margin: "12px 0", flexWrap: "wrap" }}>
        <label><input type="checkbox" checked={useFresh} onChange={(e) => setUseFresh(e.target.checked)} /> recencyDecay profile (fresh)</label>
        <label>recency weight {recencyW}
          <input type="range" min={0} max={20} value={recencyW} disabled={!useFresh} onChange={(e) => setRecencyW(+e.target.value)} /></label>
        <label>relevance weight {relW}
          <input type="range" min={0} max={10} value={relW} disabled={!useFresh} onChange={(e) => setRelW(+e.target.value)} /></label>
      </div>
      <div style={{ margin: "12px 0" }}>
        <strong>Multi-key sort</strong> (disabled while a rank profile is active):
        {sortKeys.map((k, i) => (
          <span key={i} style={{ marginLeft: 8 }}>
            <select value={k.field} disabled={useFresh}
              onChange={(e) => setSortKeys((ks) => ks.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}>
              {SORT_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <select value={k.order} disabled={useFresh}
              onChange={(e) => setSortKeys((ks) => ks.map((x, j) => (j === i ? { ...x, order: e.target.value as "asc" | "desc" } : x)))}>
              <option value="asc">asc</option><option value="desc">desc</option>
            </select>
          </span>
        ))}
        <button style={{ marginLeft: 8 }} disabled={useFresh} onClick={() => setSortKeys((ks) => [...ks, { field: "rating", order: "desc" }])}>+ key</button>
        {sortKeys.length > 0 && <button disabled={useFresh} onClick={() => setSortKeys((ks) => ks.slice(0, -1))}>− key</button>}
      </div>
      <p style={{ color: "#666" }}>{result ? `${result.found} results` : "loading…"}</p>
      {result && <ProductGrid hits={result.hits} showScore />}
    </div>
  );
}
