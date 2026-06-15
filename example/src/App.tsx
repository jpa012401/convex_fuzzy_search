import { useState } from "react";
import { Storefront } from "./Storefront";
import { RankingLab } from "./RankingLab";
import { PlacesPage } from "./PlacesPage";
import { IndexAdmin } from "./IndexAdmin";

type Tab = "storefront" | "ranking" | "places" | "admin";
const TABS: { key: Tab; label: string }[] = [
  { key: "storefront", label: "Storefront" },
  { key: "ranking", label: "Ranking Lab" },
  { key: "places", label: "Places" },
  { key: "admin", label: "Index Admin" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("storefront");
  return (
    <div>
      <nav style={{ display: "flex", gap: 8, padding: "8px 16px", borderBottom: "1px solid #ddd" }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ fontWeight: tab === t.key ? 700 : 400, padding: "6px 12px",
              border: "none", borderBottom: tab === t.key ? "2px solid #1565c0" : "2px solid transparent",
              background: "none", cursor: "pointer" }}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "storefront" && <Storefront />}
      {tab === "ranking" && <RankingLab />}
      {tab === "places" && <PlacesPage />}
      {tab === "admin" && <IndexAdmin />}
    </div>
  );
}
