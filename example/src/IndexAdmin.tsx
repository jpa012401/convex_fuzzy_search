import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";

function StatsPanel({ label, stats }: { label: string; stats: any }) {
  if (!stats) return <div>{label}: loading…</div>;
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, minWidth: 260 }}>
      <strong>{label}</strong>
      <div>out_of: {stats.out_of}</div>
      <div>facets: {stats.facets?.map((f: any) => `${f.field}(${f.distinctValues})`).join(", ") || "—"}</div>
      <div>sortSpecs: {stats.sortSpecs?.map((s: any) => `${s.specId}:${s.count}`).join(", ") || "—"}</div>
    </div>
  );
}

export function IndexAdmin() {
  const productStats = useQuery(api.products.indexStats);
  const placeStats = useQuery(api.places.placeStats);
  const seedProducts = useMutation(api.products.startSeed);
  const seedPlaces = useMutation(api.places.seedPlaces);
  const syncProducts = useMutation(api.products.sync);
  const syncPlaces = useMutation(api.places.sync);
  const reindexPlaces = useMutation(api.places.reindexPlaces);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<any>) => {
    setMsg(`${label}…`);
    try { const r = await fn(); setMsg(`${label}: ${JSON.stringify(r)}`); }
    catch (e: any) { setMsg(`${label} ERROR: ${e.message ?? e}`); }
  };

  return (
    <div style={{ padding: 16 }}>
      <h2>Index Admin</h2>
      <p style={{ color: "#666", marginTop: 0 }}>Seed, sync config, reindex, and inspect index health for each collection.</p>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        <StatsPanel label="products" stats={productStats} />
        <StatsPanel label="places" stats={placeStats} />
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => run("seed products", () => seedProducts({ total: 200, batch: 50 }))}>Seed products (200)</button>
        <button onClick={() => run("seed places", () => seedPlaces({ total: 120 }))}>Seed places (120)</button>
        <button onClick={() => run("sync products", () => syncProducts({}))}>Sync products</button>
        <button onClick={() => run("sync places", () => syncPlaces({}))}>Sync places</button>
        <button onClick={() => run("reindex places", () => reindexPlaces({}))}>Reindex places</button>
      </div>
      {msg && <pre style={{ marginTop: 12, background: "#f6f6f6", padding: 8, borderRadius: 6, whiteSpace: "pre-wrap" }}>{msg}</pre>}
    </div>
  );
}
