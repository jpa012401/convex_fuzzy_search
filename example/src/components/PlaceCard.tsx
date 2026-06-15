function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)) * 10) / 10;
}

type Hit = { id: string; score?: number; document: Record<string, any> };

export function PlaceCard({ hit, origin, now }: { hit: Hit; origin: { lat: number; lng: number }; now: number }) {
  const d = hit.document;
  const dist = d.lat != null ? kmBetween(origin, { lat: d.lat, lng: d.lng }) : null;
  const daysOpen = d.openedAt != null ? Math.round((now - d.openedAt) / 86_400_000) : null;
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
      <img src={d.image} alt={d.name} style={{ width: "100%", borderRadius: 4 }} />
      <div style={{ fontWeight: 600 }}>{d.name}</div>
      <div style={{ color: "#666", fontSize: 13 }}>{d.cuisine} · {"$".repeat(d.priceLevel ?? 1)} · ★{d.rating}</div>
      <div style={{ fontSize: 12, color: "#888" }}>
        {dist != null ? `${dist} km away` : "—"}{daysOpen != null ? ` · opened ${daysOpen}d ago` : ""} · score {hit.score}
      </div>
    </div>
  );
}
