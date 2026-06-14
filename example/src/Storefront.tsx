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
  // Weighted-score (rankBy) controls: blend relevance with the `popularity` field.
  const [textWeight, setTextWeight] = useState(1);
  const [popWeight, setPopWeight] = useState(0);
  const [affWeight, setAffWeight] = useState(0);
  const seed = useMutation(api.products.seed);
  const startSeed = useMutation(api.products.startSeed);
  const [loadMsg, setLoadMsg] = useState<string | null>(null);

  const onLoad5k = async () => {
    setLoadMsg("Seeding 5,000 products in the background — the result count will climb live as batches land.");
    await startSeed({});
    setPage(1);
  };

  const filterBy = buildFilterBy(selected);
  const result = useQuery(api.products.searchProducts, {
    q,
    page,
    perPage: PER_PAGE,
    filterBy,
    facetBy: ["brand", "category"],
    sortBy: SORTS[sort],
    rankBy: {
      text: textWeight,
      fields: [
        { field: "popularity", weight: popWeight },
        { field: "affinity", weight: affWeight },
      ],
    },
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
          <button onClick={() => seed()}>Seed 6</button>
          <button onClick={onLoad5k}>Load 5k</button>
        </div>
        {loadMsg && <p style={{ fontSize: 13, color: "#888" }}>{loadMsg}</p>}

        <WeightedScorePanel
          textWeight={textWeight}
          popWeight={popWeight}
          affWeight={affWeight}
          onText={(w) => { setTextWeight(w); setPage(1); }}
          onPop={(w) => { setPopWeight(w); setPage(1); }}
          onAff={(w) => { setAffWeight(w); setPage(1); }}
          active={sort === "relevance"}
        />

        <p>{result ? `${result.found} results · ${result.search_time_ms} ms` : "Loading…"}</p>
        <ProductGrid hits={result?.hits ?? []} showScore={sort === "relevance"} />
        <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span>Page {page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}

function WeightedScorePanel({
  textWeight,
  popWeight,
  affWeight,
  onText,
  onPop,
  onAff,
  active,
}: {
  textWeight: number;
  popWeight: number;
  affWeight: number;
  onText: (w: number) => void;
  onPop: (w: number) => void;
  onAff: (w: number) => void;
  active: boolean;
}) {
  const slider = (label: string, value: number, on: (w: number) => void) => (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <span style={{ width: 130 }}>{label}</span>
      <input
        type="range"
        min={0}
        max={3}
        step={0.5}
        value={value}
        onChange={(e) => on(Number(e.target.value))}
      />
      <span style={{ width: 24, textAlign: "right" }}>{value}</span>
    </label>
  );
  return (
    <div
      style={{
        margin: "12px 0",
        padding: 12,
        border: "1px solid #ddd",
        borderRadius: 8,
        background: "#fafafa",
        color: "#222",
        maxWidth: 360,
        opacity: active ? 1 : 0.5,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Weighted score (rankBy)</div>
      {slider("Relevance weight", textWeight, onText)}
      {slider("Popularity weight", popWeight, onPop)}
      {slider("Affinity (personalize)", affWeight, onAff)}
      <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
        score = {textWeight}·text_match + {popWeight}·popularity + {affWeight}·affinity
        {active ? "" : " — switch Sort to “Relevance” to see this ordering"}
      </div>
      <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>
        Affinity = match to the demo user (preferred categories/brands, past
        searches, viewed items). Needs the <strong>Load 5k</strong> dataset.
      </div>
    </div>
  );
}
