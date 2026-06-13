export function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      placeholder="Search products…"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ flex: 1, padding: 8, fontSize: 16 }}
    />
  );
}
