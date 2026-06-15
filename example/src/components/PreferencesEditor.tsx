import { useState } from "react";
import { CATEGORY_OPTIONS, BRAND_OPTIONS } from "../../convex/dataset";

export type Profile = {
  preferredCategories: string[];
  preferredBrands: string[];
  pastSearchTerms: string[];
};

const toggle = (arr: string[], v: string) =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

export function PreferencesEditor({
  profile,
  onSave,
  status,
}: {
  profile: Profile | undefined;
  onSave: (p: Profile) => void;
  status: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [cats, setCats] = useState<string[]>([]);
  const [brands, setBrands] = useState<string[]>([]);
  const [terms, setTerms] = useState("");

  // Sync local edit state when the stored profile loads/changes, using React's
  // "adjust state during render" pattern (no effect): when the profile object
  // identity changes, reset the derived edit fields in the same render.
  const [seenProfile, setSeenProfile] = useState<Profile | undefined>(undefined);
  if (profile && profile !== seenProfile) {
    setSeenProfile(profile);
    setCats(profile.preferredCategories);
    setBrands(profile.preferredBrands);
    setTerms(profile.pastSearchTerms.join(", "));
  }

  if (!profile) return null;

  const box = (
    label: string,
    options: string[],
    selected: string[],
    set: (v: string[]) => void,
    scroll?: boolean,
  ) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{label}</div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "2px 12px",
          maxHeight: scroll ? 96 : undefined,
          overflowY: scroll ? "auto" : undefined,
          border: scroll ? "1px solid #eee" : undefined,
          padding: scroll ? 6 : 0,
          borderRadius: 4,
        }}
      >
        {options.map((o) => (
          <label key={o} style={{ fontSize: 13, display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={selected.includes(o)}
              onChange={() => set(toggle(selected, o))}
            />
            {o}
          </label>
        ))}
      </div>
    </div>
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
        maxWidth: 560,
      }}
    >
      <button onClick={() => setOpen((o) => !o)} style={{ fontWeight: 600 }}>
        {open ? "▾" : "▸"} My preferences
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          {box("Preferred categories", CATEGORY_OPTIONS, cats, setCats)}
          {box("Preferred brands", BRAND_OPTIONS, brands, setBrands, true)}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
              Past searches (comma-separated)
            </div>
            <input
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="wireless, trail, waterproof"
              style={{ width: "100%", padding: 6, fontSize: 13 }}
            />
          </div>
          <button
            onClick={() =>
              onSave({
                preferredCategories: cats,
                preferredBrands: brands,
                pastSearchTerms: terms.split(",").map((s) => s.trim()).filter(Boolean),
              })
            }
          >
            Save &amp; re-personalize
          </button>
          {status && <span style={{ marginLeft: 10, fontSize: 13, color: "#666" }}>{status}</span>}
          <div style={{ fontSize: 11, color: "#999", marginTop: 8 }}>
            Saving recomputes each product's <code>affinity</code> and re-seeds the
            5k dataset in the background (~1 min). Then raise the Affinity weight to
            see your preferences reorder results.
          </div>
        </div>
      )}
    </div>
  );
}
