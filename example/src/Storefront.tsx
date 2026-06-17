import { useState, type ReactNode } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { SearchBar } from "./components/SearchBar";
import { ProductGrid } from "./components/ProductGrid";
import { FacetSidebar } from "./components/FacetSidebar";
import { PreferencesEditor, type Profile } from "./components/PreferencesEditor";
import { CATEGORY_OPTIONS } from "../convex/dataset";

const PER_PAGE = 20;

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
  // Lean rank PROFILE ("boosted"): re-ranks a bounded top-N window off the
  // popularity base order, boosting popularity + affinity + the preferred
  // categories passed as query-time context. No full-collection load.
  const [boostEnabled, setBoostEnabled] = useState(false);
  const [prefCats, setPrefCats] = useState<string[]>([]);
  const seed = useMutation(api.products.seed);
  const startSeed = useMutation(api.products.startSeed);
  const recomputeAffinities = useMutation(api.products.recomputeAffinities);
  const profile = useQuery(api.products.getProfile);
  const setProfile = useMutation(api.products.setProfile);
  const indexStats = useQuery(api.products.indexStats);
  const [loadMsg, setLoadMsg] = useState<string | null>(null);
  const [prefsMsg, setPrefsMsg] = useState<string | null>(null);

  const onLoad5k = async () => {
    setLoadMsg("Seeding 5,000 products in the background — the result count will climb live as batches land.");
    await startSeed({ reset: true });
    setPage(1);
  };

  const onSavePrefs = async (p: Profile) => {
    setPrefsMsg("Saving + re-personalizing 5,000 products in the background (~1 min)…");
    await setProfile(p);
    await recomputeAffinities({});
    setPage(1);
  };

  const filterBy = buildFilterBy(selected);
  // The lean rank profile re-ranks a top-N window off the popularity sort index,
  // boosting the preferred categories via query-time context. No full load.
  const rank = boostEnabled
    ? { profile: "boosted" as const, context: { sets: { prefCats } } }
    : undefined;
  const result = useQuery(api.products.searchProducts, {
    q,
    page,
    perPage: PER_PAGE,
    filterBy,
    facetBy: ["brand", "category"],
    sortBy: SORTS[sort],
    rank,
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
          <label
            title="Lean rank profile: re-ranks a top-N window off the popularity sort index, boosting your preferred categories. No full-collection load."
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginLeft: "auto" }}
          >
            <input
              type="checkbox"
              checked={boostEnabled}
              onChange={(e) => { setBoostEnabled(e.target.checked); setPage(1); }}
            />
            Lean boost profile
          </label>
        </div>
        {loadMsg && <p style={{ fontSize: 13, color: "#888" }}>{loadMsg}</p>}

        <Collapsible summary="Demo controls & diagnostics">
          <PreferencesEditor profile={profile} onSave={onSavePrefs} status={prefsMsg} />
          <LeanBoostPanel
            active={boostEnabled}
            prefCats={prefCats}
            onToggle={(c) => { setPrefCats((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c])); setPage(1); }}
          />
          <IndexStats stats={indexStats} />
        </Collapsible>

        <p>
          {result
            ? `${result.found_approximate ? "≈" : ""}${result.found} results${
                boostEnabled ? (result.reranked ? " · lean re-rank (window)" : " · base-order tail") : ""
              }`
            : "Loading…"}
        </p>
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

// A simple collapsible section (collapsed by default) to keep the demo controls
// out of the way until needed.
function Collapsible({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details style={{ margin: "12px 0", maxWidth: 560 }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#444" }}>{summary}</summary>
      <div style={{ marginTop: 8 }}>{children}</div>
    </details>
  );
}

// Lean rank-profile control: pick preferred categories that the "boosted"
// profile floats up, re-ranking a top-N window off the popularity sort index
// (no full-collection load).
function LeanBoostPanel({
  active,
  prefCats,
  onToggle,
}: {
  active: boolean;
  prefCats: string[];
  onToggle: (c: string) => void;
}) {
  return (
    <div
      style={{
        margin: "12px 0",
        padding: 12,
        border: "1px solid #ddd",
        borderRadius: 8,
        background: "#fafafa",
        color: "#222",
        opacity: active ? 1 : 0.5,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        Lean boost profile (rank: <code>boosted</code>)
      </div>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
        Re-ranks a top-N <strong>window</strong> off the popularity index: boosts
        popularity + affinity + the preferred categories below (sent as query
        <code> context.sets.prefCats</code>). No full-collection scan.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px" }}>
        {CATEGORY_OPTIONS.map((c) => (
          <label key={c} style={{ fontSize: 13, display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={prefCats.includes(c)} onChange={() => onToggle(c)} />
            {c}
          </label>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "#999", marginTop: 6 }}>
        {active
          ? "On — toggle “Lean boost profile” in the toolbar to switch off."
          : "Off — enable “Lean boost profile” in the toolbar. Needs the Load 5k dataset."}
      </div>
    </div>
  );
}

// Validation panel: live counts held in the component's aggregate/counter
// stores. For a fully-reindexed collection every facet `total` and every
// sort-spec `count` equals `out_of`; a mismatch is flagged.
function IndexStats({
  stats,
}: {
  stats:
    | {
        out_of: number;
        facets: { field: string; distinctValues: number; total: number; truncated: boolean }[];
        sortSpecs: { specId: string; count: number }[];
      }
    | undefined;
}) {
  if (!stats) return null;
  // Sort specs MUST equal out_of (every doc is indexed in every spec). A facet
  // total counts only docs that HAVE the field, so a partial total is normal for
  // a sparse field; only an empty (0) total is flagged.
  const sortMark = (n: number) =>
    n === stats.out_of
      ? <span style={{ color: "#2e7d32" }}>✓</span>
      : <span style={{ color: "#c62828" }}>✗ needs reindex</span>;
  const facetMark = (n: number) =>
    n === stats.out_of ? <span style={{ color: "#2e7d32" }}>✓ all</span>
    : n > 0 ? <span style={{ color: "#999" }}>partial (sparse field?)</span>
    : <span style={{ color: "#c62828" }}>✗ empty — needs reindex?</span>;
  const row = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, lineHeight: 1.7 } as const;
  return (
    <div
      style={{
        margin: "12px 0",
        padding: 12,
        border: "1px solid #ddd",
        borderRadius: 8,
        background: "#fafafa",
        color: "#222",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        Index validation (live aggregate / counter counts)
      </div>
      <div style={row}>
        <span><strong>Documents</strong> (docCount aggregate / <code>out_of</code>)</span>
        <span>{stats.out_of}</span>
      </div>
      <div style={{ fontWeight: 600, fontSize: 12, marginTop: 8 }}>Facet counters</div>
      {stats.facets.length === 0 && <div style={{ fontSize: 12, color: "#999" }}>none declared</div>}
      {stats.facets.map((f) => (
        <div key={f.field} style={row}>
          <span>{f.field} · {f.truncated ? "≥" : ""}{f.distinctValues} values</span>
          <span>total {f.total} {facetMark(f.total)}</span>
        </div>
      ))}
      <div style={{ fontWeight: 600, fontSize: 12, marginTop: 8 }}>Sort index</div>
      {stats.sortSpecs.length === 0 && <div style={{ fontSize: 12, color: "#999" }}>none declared</div>}
      {stats.sortSpecs.map((s) => (
        <div key={s.specId} style={row}>
          <span><code>{s.specId}</code></span>
          <span>{s.count} entries {sortMark(s.count)}</span>
        </div>
      ))}
      <div style={{ fontSize: 11, color: "#999", marginTop: 6 }}>
        Sort counts must equal Documents (every doc is indexed in every spec).
        Facet totals count only docs that HAVE the field, so a partial total is
        normal for a sparse field; an empty (0) total usually means it was never
        written or needs a reindex.
      </div>
    </div>
  );
}
