import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { SearchBar } from "./components/SearchBar";
import { PlaceCard } from "./components/PlaceCard";
import { CITY_PRESETS } from "../convex/placesData";

export function PlacesPage() {
  const now = useMemo(() => Date.now(), []);
  const [q, setQ] = useState("");
  const [origin, setOrigin] = useState(CITY_PRESETS[0]);
  const [geoW, setGeoW] = useState(5);
  const [freshW, setFreshW] = useState(2);

  const result = useQuery(api.places.searchPlaces, {
    q, perPage: 12,
    rank: { profile: "nearby", weights: { geo: geoW, fresh: freshW }, context: { now, origin: { lat: origin.lat, lng: origin.lng } } },
  });

  return (
    <div style={{ padding: 16 }}>
      <h2>Places — geoDistance</h2>
      <p style={{ color: "#666", marginTop: 0 }}>Re-ranks restaurants by distance from your location, recency (newly opened), and text relevance.</p>
      <SearchBar value={q} onChange={setQ} />
      <div style={{ display: "flex", gap: 16, alignItems: "center", margin: "12px 0", flexWrap: "wrap" }}>
        <label>My location:{" "}
          <select value={origin.name} onChange={(e) => setOrigin(CITY_PRESETS.find((c) => c.name === e.target.value)!)}>
            {CITY_PRESETS.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </label>
        <label>geo weight {geoW}<input type="range" min={0} max={20} value={geoW} onChange={(e) => setGeoW(+e.target.value)} /></label>
        <label>recency weight {freshW}<input type="range" min={0} max={20} value={freshW} onChange={(e) => setFreshW(+e.target.value)} /></label>
      </div>
      <p style={{ color: "#666" }}>{result ? `${result.found} places` : "loading…"}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 16 }}>
        {result?.hits.map((h: any) => <PlaceCard key={h.id} hit={h} origin={{ lat: origin.lat, lng: origin.lng }} now={now} />)}
      </div>
    </div>
  );
}
