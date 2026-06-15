type Hit = {
  id: string;
  score?: number;
  document: Record<string, any>;
  highlight?: { name?: { snippet: string } };
};

export function ProductGrid({ hits, showScore }: { hits: Hit[]; showScore?: boolean }) {
  if (hits.length === 0) return <p>No products found.</p>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 16 }}>
      {hits.map((h) => (
        <div key={h.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <img src={h.document.image} alt={h.document.name} style={{ width: "100%", borderRadius: 4 }} />
          <div
            style={{ fontWeight: 600 }}
            // snippet is HTML-escaped by the component except for <mark> tags
            dangerouslySetInnerHTML={{
              __html: h.highlight?.name?.snippet ?? h.document.name,
            }}
          />
          <div style={{ color: "#666", fontSize: 13 }}>
            {h.document.brand}
            {h.document.category ? ` · ${h.document.category}` : ""}
          </div>
          <div>${h.document.price}</div>
          {showScore && (
            <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
              pop {h.document.popularity ?? "—"} · aff {h.document.affinity ?? "—"} · match {h.score}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
