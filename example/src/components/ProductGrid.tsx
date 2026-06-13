type Hit = { document: Record<string, any> };

export function ProductGrid({ hits }: { hits: Hit[] }) {
  if (hits.length === 0) return <p>No products found.</p>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 16 }}>
      {hits.map((h) => (
        <div key={h.document.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <img src={h.document.image} alt={h.document.name} style={{ width: "100%", borderRadius: 4 }} />
          <div style={{ fontWeight: 600 }}>{h.document.name}</div>
          <div style={{ color: "#666", fontSize: 13 }}>{h.document.brand}</div>
          <div>${h.document.price}</div>
        </div>
      ))}
    </div>
  );
}
