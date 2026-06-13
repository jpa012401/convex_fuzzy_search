export function FacetSidebar() {
  return (
    <aside style={{ width: 200, opacity: 0.5 }}>
      <h3>Filters</h3>
      <p style={{ fontSize: 12 }}>Brand, category, price — <em>coming in Phase 2</em></p>
      <h3>Sort</h3>
      <select disabled>
        <option>Relevance (Phase 3)</option>
      </select>
    </aside>
  );
}
