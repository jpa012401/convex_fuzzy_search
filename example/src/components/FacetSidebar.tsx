type FacetCount = { field_name: string; counts: { value: string; count: number }[] };

export function FacetSidebar({
  facets,
  selected,
  onToggle,
}: {
  facets: FacetCount[];
  selected: Record<string, string[]>;
  onToggle: (field: string, value: string) => void;
}) {
  return (
    <aside style={{ width: 220 }}>
      <h3>Filters</h3>
      {facets.map((f) => (
        <div key={f.field_name} style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, textTransform: "capitalize" }}>{f.field_name}</div>
          {f.counts.map((c) => (
            <label key={c.value} style={{ display: "block", fontSize: 14 }}>
              <input
                type="checkbox"
                checked={(selected[f.field_name] ?? []).includes(c.value)}
                onChange={() => onToggle(f.field_name, c.value)}
              />{" "}
              {c.value} <span style={{ color: "#888" }}>({c.count})</span>
            </label>
          ))}
        </div>
      ))}
      <h3>Sort</h3>
      <select disabled>
        <option>Relevance</option>
      </select>
    </aside>
  );
}
